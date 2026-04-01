/**
 * briefing-slack/index.ts
 *
 * Lambda — triggered by SQS queue that is subscribed to the
 * briefings-generated SNS topic.
 *
 * Posts a rich Block Kit message to a Slack channel via Incoming Webhook:
 *
 *   ┌─────────────────────────────────────────────────┐
 *   │  ☀️  Morning Briefing — April 1, 2026           │  ← header
 *   │  2-3 sentence summary of the briefing...        │  ← section
 *   │  Open Briefing →                                │  ← markdown link (no interactivity needed)
 *   └─────────────────────────────────────────────────┘
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const SSM_WEBHOOK = process.env.SSM_SLACK_WEBHOOK_URL ?? '/briefings/slack-webhook-url';

// Cached webhook URL — persists across warm invocations
let cachedWebhookUrl: string | null = null;

async function getWebhookUrl(): Promise<string> {
  if (!cachedWebhookUrl) {
    const res = await ssm.send(new GetParameterCommand({ Name: SSM_WEBHOOK, WithDecryption: true }));
    cachedWebhookUrl = res.Parameter?.Value ?? '';
  }
  return cachedWebhookUrl;
}

// ---------------------------------------------------------------------------
// Slack message builder
// ---------------------------------------------------------------------------
interface BriefingEvent {
  emoji: string;
  label: 'Morning' | 'Evening';
  date: string;        // "2026-04-01"
  fullUrl: string;     // "https://briefings.stevenowicki.com/2026/04/01-0800.html"
  summary: string;
}

function buildSlackPayload(event: BriefingEvent): object {
  const displayDate = new Date(event.date + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });

  const headerText = `${event.emoji} ${event.label} Briefing — ${displayDate}`;
  const summaryText = `<!channel> ${event.summary || `Your ${event.label.toLowerCase()} briefing is ready.`}`;

  return {
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: headerText, emoji: true },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: summaryText },
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `<${event.fullUrl}|Open ${event.label} Briefing →>` },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Slack Incoming Webhook POST
// ---------------------------------------------------------------------------
async function postToSlack(event: BriefingEvent): Promise<void> {
  const webhookUrl = await getWebhookUrl();
  const payload = buildSlackPayload(event);

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  // Slack returns plain-text "ok" on success
  const text = await res.text();

  if (!res.ok || text !== 'ok') {
    throw new Error(`Slack webhook error [${res.status}]: ${text}`);
  }

  console.log(`[slack] ✅ Message posted — ${event.label} briefing for ${event.date}`);
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
      console.log(`[slack] Processing: ${payload.label} briefing for ${payload.date}`);
      await postToSlack(payload);
    } catch (err) {
      console.error(`[slack] Failed for record ${record.messageId}:`, err);
      failures.push(record.messageId);
    }
  }

  return {
    batchItemFailures: failures.map(id => ({ itemIdentifier: id })),
  };
}
