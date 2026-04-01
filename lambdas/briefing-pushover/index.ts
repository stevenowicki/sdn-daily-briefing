/**
 * briefing-pushover/index.ts
 *
 * Lambda — triggered by SQS queue that is subscribed to the
 * briefings-generated SNS topic.
 *
 * Sends a Pushover push notification to Steve's iPhone with:
 *   title:     "☀️ Morning Briefing — April 1, 2026"
 *   message:   2-3 sentence summary
 *   url:       https://briefings.stevenowicki.com/2026/04/01-0800.html
 *   url_title: "Open Morning Briefing"
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const SSM_TOKEN = process.env.SSM_PUSHOVER_API_TOKEN ?? '/briefings/pushover-api-token';
const SSM_USER  = process.env.SSM_PUSHOVER_USER_KEY  ?? '/briefings/pushover-user-key';

// Cached credentials
let cachedToken: string | null = null;
let cachedUserKey: string | null = null;

async function getCredentials(): Promise<{ token: string; userKey: string }> {
  if (!cachedToken || !cachedUserKey) {
    const [tokenRes, userRes] = await Promise.all([
      ssm.send(new GetParameterCommand({ Name: SSM_TOKEN, WithDecryption: true })),
      ssm.send(new GetParameterCommand({ Name: SSM_USER,  WithDecryption: true })),
    ]);
    cachedToken   = tokenRes.Parameter?.Value ?? '';
    cachedUserKey = userRes.Parameter?.Value  ?? '';
  }
  return { token: cachedToken, userKey: cachedUserKey };
}

// ---------------------------------------------------------------------------
// Pushover API call
// ---------------------------------------------------------------------------
interface BriefingEvent {
  emoji: string;
  label: 'Morning' | 'Evening';
  date: string;
  fullUrl: string;
  summary: string;
}

async function sendPushoverNotification(event: BriefingEvent): Promise<void> {
  const { token, userKey } = await getCredentials();

  const displayDate = new Date(event.date + 'T12:00:00Z').toLocaleDateString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  const title     = `${event.emoji} ${event.label} Briefing — ${displayDate}`;
  const urlTitle  = `Open ${event.label} Briefing`;

  const body = new URLSearchParams({
    token,
    user:       userKey,
    title,
    message:    event.summary || `${event.label} briefing is ready.`,
    url:        event.fullUrl,
    url_title:  urlTitle,
    priority:   '0',      // Normal priority
    sound:      'none',
  });

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const json = await res.json() as { status: number; request?: string; errors?: string[] };

  if (json.status !== 1) {
    throw new Error(`Pushover API error: ${JSON.stringify(json.errors)}`);
  }

  console.log(`[pushover] ✅ Notification sent — request ID: ${json.request}`);
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event: SQSEvent): Promise<SQSBatchResponse> {
  const failures: string[] = [];

  for (const record of event.Records) {
    try {
      // SQS message body is the raw SNS payload (rawMessageDelivery=true)
      const payload = JSON.parse(record.body) as BriefingEvent;
      console.log(`[pushover] Processing: ${payload.label} briefing for ${payload.date}`);
      await sendPushoverNotification(payload);
    } catch (err) {
      console.error(`[pushover] Failed for record ${record.messageId}:`, err);
      failures.push(record.messageId);
    }
  }

  // Return failed item identifiers so SQS can retry them
  return {
    batchItemFailures: failures.map(id => ({ itemIdentifier: id })),
  };
}
