/**
 * briefing-alarms/index.ts
 *
 * Lambda — triggered by SNS when a CloudWatch Alarm changes state.
 *
 * Posts a formatted Slack message to the #briefings channel:
 *   🚨 ALARM:    red alert with reason + console link
 *   ✅ RESOLVED: green confirmation
 *   ⚠️ INSUFFICIENT_DATA: yellow advisory
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import type { SNSEvent } from 'aws-lambda';

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const SSM_WEBHOOK = process.env.SSM_SLACK_WEBHOOK_URL ?? '/briefings/slack-webhook-url';
const DASHBOARD_NAME = process.env.DASHBOARD_NAME ?? 'Briefings-prod';

let cachedWebhookUrl: string | null = null;

async function getWebhookUrl(): Promise<string> {
  if (!cachedWebhookUrl) {
    const res = await ssm.send(new GetParameterCommand({ Name: SSM_WEBHOOK, WithDecryption: true }));
    cachedWebhookUrl = res.Parameter?.Value ?? '';
  }
  return cachedWebhookUrl;
}

// ---------------------------------------------------------------------------
// CloudWatch Alarm notification shape (from SNS Message JSON)
// ---------------------------------------------------------------------------
interface AlarmNotification {
  AlarmName: string;
  AlarmDescription?: string;
  AWSAccountId: string;
  NewStateValue: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  NewStateReason: string;
  StateChangeTime: string;   // ISO 8601
  Region: string;
  AlarmArn: string;
  OldStateValue: string;
  Trigger: {
    MetricName: string;
    Namespace: string;
    Dimensions: Array<{ name: string; value: string }>;
  };
}

// ---------------------------------------------------------------------------
// Slack payload builder
// ---------------------------------------------------------------------------
function buildSlackPayload(alarm: AlarmNotification): object {
  const stateConfig = {
    ALARM:             { emoji: '🚨', verb: 'ALARM',            headerSuffix: '' },
    OK:                { emoji: '✅', verb: 'RESOLVED',         headerSuffix: '' },
    INSUFFICIENT_DATA: { emoji: '⚠️', verb: 'INSUFFICIENT DATA', headerSuffix: '' },
  }[alarm.NewStateValue] ?? { emoji: '❓', verb: alarm.NewStateValue, headerSuffix: '' };

  const time = new Date(alarm.StateChangeTime).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  const alarmConsoleUrl =
    `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1` +
    `#alarmsV2:alarm/${encodeURIComponent(alarm.AlarmName)}`;

  const dashboardUrl =
    `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1` +
    `#dashboards:name=${encodeURIComponent(DASHBOARD_NAME)}`;

  const description = alarm.AlarmDescription ?? '_No description provided_';

  const dimensions = alarm.Trigger.Dimensions
    .map(d => `${d.name}: \`${d.value}\``)
    .join('  ·  ');

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${stateConfig.emoji} ${stateConfig.verb}: ${alarm.AlarmName}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${description}*\n\n${alarm.NewStateReason}`,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Metric*\n\`${alarm.Trigger.Namespace}/${alarm.Trigger.MetricName}\`` },
          { type: 'mrkdwn', text: `*Previous State*\n${alarm.OldStateValue}` },
          ...(dimensions ? [{ type: 'mrkdwn', text: `*Dimensions*\n${dimensions}` }] : []),
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🕐 ${time} ET  ·  <${alarmConsoleUrl}|View Alarm>  ·  <${dashboardUrl}|Dashboard>`,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event: SNSEvent): Promise<void> {
  const webhookUrl = await getWebhookUrl();

  for (const record of event.Records) {
    let alarm: AlarmNotification;
    try {
      alarm = JSON.parse(record.Sns.Message) as AlarmNotification;
    } catch {
      console.error('[alarms] Failed to parse SNS message:', record.Sns.Message);
      continue;
    }

    console.log(`[alarms] ${alarm.AlarmName}: ${alarm.OldStateValue} → ${alarm.NewStateValue}`);

    const payload = buildSlackPayload(alarm);

    const res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok || text !== 'ok') {
      throw new Error(`Slack webhook error [${res.status}]: ${text}`);
    }

    console.log(`[alarms] ✅ Posted to Slack — ${alarm.AlarmName} → ${alarm.NewStateValue}`);
  }
}
