/**
 * briefing-generator/index.ts
 *
 * Lambda handler — invoked by EventBridge Scheduler twice daily.
 *
 * Flow:
 *  1. Parse schedule event (morning vs evening, current date in ET)
 *  2. Fetch RSS feeds, weather, and market data concurrently
 *  3. Call Claude claude-opus-4-5 to generate the HTML briefing + summary
 *  4. Upload HTML to S3 at /YYYY/MM/DD-HHMM.html
 *  5. Update manifest.json in S3 (prepend new entry)
 *  6. Invalidate CloudFront for /manifest.json and /index.html
 *  7. Publish a "briefing-generated" event to SNS
 */

import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { CloudFrontClient, CreateInvalidationCommand } from '@aws-sdk/client-cloudfront';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import Anthropic from '@anthropic-ai/sdk';

import { fetchAllFeeds, FeedItem } from './lib/feeds';
import { fetchWeather } from './lib/weather';
import { fetchMarketData, formatChangePercent, formatPrice } from './lib/markets';
import { SYSTEM_PROMPT, buildUserPrompt } from './lib/prompt';

// ---------------------------------------------------------------------------
// AWS clients (shared across warm invocations)
// ---------------------------------------------------------------------------
const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
const cf = new CloudFrontClient({ region: 'us-east-1' });
const sns = new SNSClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const BUCKET = process.env.BRIEFINGS_BUCKET_NAME!;
const DIST_ID = process.env.BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID!;
const SITE_URL = process.env.BRIEFINGS_SITE_URL ?? 'https://briefings.stevenowicki.com';
const TOPIC_ARN = process.env.SNS_TOPIC_ARN!;
const SSM_ANTHROPIC_KEY = process.env.SSM_ANTHROPIC_API_KEY ?? '/briefings/anthropic-api-key';
const CLAUDE_MODEL = 'claude-opus-4-5';

// ---------------------------------------------------------------------------
// SSM cache (reused across warm invocations)
// ---------------------------------------------------------------------------
let cachedAnthropicKey: string | null = null;

async function getAnthropicKey(): Promise<string> {
  if (cachedAnthropicKey) return cachedAnthropicKey;
  const res = await ssm.send(new GetParameterCommand({
    Name: SSM_ANTHROPIC_KEY,
    WithDecryption: true,
  }));
  cachedAnthropicKey = res.Parameter?.Value ?? '';
  return cachedAnthropicKey;
}

// ---------------------------------------------------------------------------
// Schedule event payload (sent by EventBridge Scheduler)
// ---------------------------------------------------------------------------
interface ScheduleEvent {
  briefingName: 'morning' | 'evening';
  label: 'Morning' | 'Evening';
  time: string;   // "08:00" or "17:30"
  emoji: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the current date string in ET timezone */
function getEasternDate(): { isoDate: string; displayDate: string; year: string; month: string; day: string } {
  const now = new Date();
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);

  const year = etParts.find(p => p.type === 'year')!.value;
  const month = etParts.find(p => p.type === 'month')!.value;
  const day = etParts.find(p => p.type === 'day')!.value;

  const displayDate = new Date(`${year}-${month}-${day}`).toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'UTC',  // interpret as UTC since we already shifted to ET
  });

  return { isoDate: `${year}-${month}-${day}`, displayDate, year, month, day };
}

/** Convert "17:30" to ISO timestamp with ET offset */
function buildIsoTimestamp(isoDate: string, time: string): string {
  // Determine ET offset (rough — good enough for manifest metadata)
  const dateForOffset = new Date(`${isoDate}T${time}:00`);
  const etOffset = dateForOffset.toLocaleString('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'short',
  }).includes('EDT') ? '-04:00' : '-05:00';
  return `${isoDate}T${time}:00${etOffset}`;
}

/** Format feed items into a compact prompt-friendly string */
function formatFeedItems(items: FeedItem[]): string {
  if (items.length === 0) return '(no items available)';
  return items.slice(0, 30).map((item, i) =>
    `[${i + 1}] ${item.title} (${item.source})\n    ${item.summary}\n    ${item.link}`
  ).join('\n\n');
}

/** Format weather data for the prompt */
function formatWeatherForPrompt(w: Awaited<ReturnType<typeof fetchWeather>>): string {
  const rainNote = w.chanceOfRain > 30 ? ` Chance of rain: ${w.chanceOfRain}%.` : '';
  const snowNote = w.chanceOfSnow > 20 ? ` Chance of snow: ${w.chanceOfSnow}%.` : '';
  const hourlyPeak = w.hourly
    .filter(h => h.chanceOfRain > 40)
    .map(h => `${h.timeLabel} (${h.chanceOfRain}% rain)`)
    .join(', ');

  return [
    `Location: ${w.location}`,
    `Current: ${w.tempF}°F (feels like ${w.feelsLikeF}°F), ${w.description}`,
    `Today: High ${w.highF}°F / Low ${w.lowF}°F`,
    `Wind: ${w.windSpeedMph} mph ${w.windDir}`,
    `Humidity: ${w.humidity}%`,
    `UV Index: ${w.uvIndex}`,
    `Visibility: ${w.visibility} miles`,
    rainNote + snowNote,
    hourlyPeak ? `Rainy hours: ${hourlyPeak}` : '',
    `Tomorrow: High ${w.tomorrow.highF}°F / Low ${w.tomorrow.lowF}°F, ${w.tomorrow.description}. Rain chance: ${w.tomorrow.chanceOfRain}%`,
  ].filter(Boolean).join('\n');
}

/** Format market data for the prompt */
function formatMarketsForPrompt(m: Awaited<ReturnType<typeof fetchMarketData>>): string {
  const lines: string[] = [];

  if (m.sp500) {
    const dir = m.sp500.changePercent >= 0 ? '▲' : '▼';
    lines.push(`S&P 500: ${formatPrice(m.sp500.price)} ${dir} ${formatChangePercent(m.sp500.changePercent)} (prev close: ${formatPrice(m.sp500.previousClose)}) — market state: ${m.sp500.marketState}`);
  }
  if (m.nasdaq) {
    const dir = m.nasdaq.changePercent >= 0 ? '▲' : '▼';
    lines.push(`Nasdaq: ${formatPrice(m.nasdaq.price)} ${dir} ${formatChangePercent(m.nasdaq.changePercent)} (prev close: ${formatPrice(m.nasdaq.previousClose)}) — market state: ${m.nasdaq.marketState}`);
  }
  if (m.brentCrude) {
    const dir = m.brentCrude.changePercent >= 0 ? '▲' : '▼';
    lines.push(`Brent Crude: $${formatPrice(m.brentCrude.price)}/bbl ${dir} ${formatChangePercent(m.brentCrude.changePercent)}`);
  }
  if (m.bitcoin) {
    const dir = m.bitcoin.changePercent >= 0 ? '▲' : '▼';
    lines.push(`Bitcoin: $${formatPrice(m.bitcoin.price, 0)} ${dir} ${formatChangePercent(m.bitcoin.changePercent)}`);
  }

  lines.push(`(Data fetched: ${m.fetchedAt})`);
  return lines.join('\n');
}

/** Extract the trailing JSON summary line Claude appends */
function extractSummaryFromResponse(text: string): { html: string; summary: string } {
  const lines = text.trimEnd().split('\n');
  const lastLine = lines[lines.length - 1].trim();

  try {
    if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
      const parsed = JSON.parse(lastLine) as { summary?: string };
      if (parsed.summary) {
        return {
          html: lines.slice(0, -1).join('\n').trim(),
          summary: parsed.summary,
        };
      }
    }
  } catch {
    // fall through
  }

  // Fallback: return the whole text as HTML, empty summary
  console.warn('[generator] Could not extract summary JSON from Claude response');
  return { html: text.trim(), summary: '' };
}

// ---------------------------------------------------------------------------
// S3: update manifest.json
// ---------------------------------------------------------------------------
interface ManifestEntry {
  url: string;
  date: string;
  label: string;
  time: string;
  isoTimestamp: string;
  summary: string;
}

async function updateManifest(bucket: string, newEntry: ManifestEntry): Promise<void> {
  let existing: { briefings: ManifestEntry[] } = { briefings: [] };

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'manifest.json' }));
    const body = await res.Body?.transformToString('utf-8');
    if (body) {
      const parsed = JSON.parse(body);
      // Accept both { briefings: [...] } and a bare [] (e.g. manual reset)
      existing = Array.isArray(parsed) ? { briefings: [] } : parsed;
    }
  } catch {
    console.log('[manifest] Starting fresh (no existing manifest.json)');
  }

  const updated = {
    briefings: [newEntry, ...existing.briefings],
  };

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: 'manifest.json',
    Body: JSON.stringify(updated, null, 2),
    ContentType: 'application/json',
    CacheControl: 'max-age=60',
  }));

  console.log(`[manifest] Updated — total entries: ${updated.briefings.length}`);
}

// ---------------------------------------------------------------------------
// CloudFront invalidation
// ---------------------------------------------------------------------------
async function invalidateCloudFront(distId: string, paths: string[]): Promise<void> {
  await cf.send(new CreateInvalidationCommand({
    DistributionId: distId,
    InvalidationBatch: {
      CallerReference: `briefing-${Date.now()}`,
      Paths: { Quantity: paths.length, Items: paths },
    },
  }));
  console.log(`[cloudfront] Invalidated: ${paths.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Main Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event: ScheduleEvent): Promise<void> {
  console.log('[handler] Event:', JSON.stringify(event));

  const { label, time, emoji } = event;
  const { isoDate, displayDate, year, month, day } = getEasternDate();

  // S3 key: /2026/04/01-0800.html
  const cleanTime = time.replace(':', '');   // "0800" or "1730"
  const s3Key = `${year}/${month}/${day}-${cleanTime}.html`;
  const briefingUrl = `/${year}/${month}/${day}-${cleanTime}.html`;
  const fullUrl = `${SITE_URL}${briefingUrl}`;

  console.log(`[handler] Generating ${label} briefing for ${isoDate} → s3://${BUCKET}/${s3Key}`);

  // Step 1: Fetch data concurrently
  console.log('[handler] Step 1: Fetching data sources…');
  const [feeds, weather, markets, anthropicKey] = await Promise.all([
    fetchAllFeeds(),
    fetchWeather('10010').catch(err => {
      console.error('[handler] Weather fetch failed:', err);
      return null;
    }),
    fetchMarketData(),
    getAnthropicKey(),
  ]);

  // Step 2: Build prompt
  console.log('[handler] Step 2: Building Claude prompt…');
  const weatherStr = weather ? formatWeatherForPrompt(weather) : 'Weather data unavailable.';
  const marketsStr = formatMarketsForPrompt(markets);

  const promptData = {
    label,
    emoji,
    dateStr: displayDate,
    weather: weatherStr,
    markets: marketsStr,
    topItems: formatFeedItems(feeds.top),
    nycItems: formatFeedItems(feeds.nyc),
    artsItems: formatFeedItems(feeds.arts),
  };

  // Step 3: Call Claude
  console.log('[handler] Step 3: Calling Claude…');
  const anthropic = new Anthropic({ apiKey: anthropicKey });

  const message = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildUserPrompt(promptData) }],
  });

  const rawResponse = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('');

  const { html, summary } = extractSummaryFromResponse(rawResponse);
  console.log(`[handler] Claude response: ${html.length} chars HTML, summary: "${summary.slice(0, 80)}…"`);

  // Step 4: Upload HTML to S3
  console.log(`[handler] Step 4: Uploading HTML to s3://${BUCKET}/${s3Key}…`);
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    Body: html,
    ContentType: 'text/html',
    CacheControl: 'max-age=31536000, immutable',
  }));

  // Step 5: Update manifest.json
  console.log('[handler] Step 5: Updating manifest.json…');
  const isoTimestamp = buildIsoTimestamp(isoDate, time);
  const manifestEntry: ManifestEntry = {
    url: briefingUrl,
    date: isoDate,
    label,
    time,
    isoTimestamp,
    summary,
  };
  await updateManifest(BUCKET, manifestEntry);

  // Step 6: CloudFront invalidation
  console.log('[handler] Step 6: Invalidating CloudFront…');
  await invalidateCloudFront(DIST_ID, ['/manifest.json', '/index.html']);

  // Step 7: Publish SNS event
  console.log('[handler] Step 7: Publishing SNS event…');
  const snsPayload = {
    briefingId: `${isoDate}-${cleanTime}`,
    url: briefingUrl,
    fullUrl,
    date: isoDate,
    label,
    time,
    isoTimestamp,
    summary,
    emoji,
  };

  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN,
    Subject: `${emoji} ${label} Briefing — ${displayDate}`,
    Message: JSON.stringify(snsPayload),
    MessageAttributes: {
      label: { DataType: 'String', StringValue: label },
      env: { DataType: 'String', StringValue: process.env.ENV ?? 'prod' },
    },
  }));

  console.log(`[handler] ✅ Done. Briefing live at ${fullUrl}`);
}
