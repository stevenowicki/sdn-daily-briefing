/**
 * briefing-deploy-notifier/index.ts
 *
 * Lambda — triggered by EventBridge rules on the default bus when a deployment
 * occurs to either the Amplify CI/CD pipeline or a Briefings CloudFormation stack.
 *
 * Handles two event types:
 *
 *  1. aws.amplify / "Amplify Deployment Status Change"
 *     Fired when an Amplify build completes (SUCCEED or FAILED).
 *     Maps to: git push → Amplify CI/CD → index.html + CDK deploy.
 *
 *  2. aws.cloudformation / "CloudFormation Stack Status Change"
 *     Fired when a Briefings-* stack reaches a terminal state.
 *     Maps to: CDK stack create/update/rollback.
 *
 * Posts a Block Kit message to Slack #ops.
 */

import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';

const ssm = new SSMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });

const SSM_WEBHOOK = process.env.SSM_SLACK_WEBHOOK_URL ?? '/briefings/slack-ops-webhook-url';
const AMPLIFY_APP_ID = process.env.AMPLIFY_APP_ID ?? 'd1tikygvw88dgp';

let cachedWebhookUrl: string | null = null;

async function getWebhookUrl(): Promise<string> {
  if (!cachedWebhookUrl) {
    const res = await ssm.send(new GetParameterCommand({ Name: SSM_WEBHOOK, WithDecryption: true }));
    cachedWebhookUrl = res.Parameter?.Value ?? '';
  }
  return cachedWebhookUrl;
}

// ---------------------------------------------------------------------------
// EventBridge event shapes
// ---------------------------------------------------------------------------

interface AmplifyDeploymentEvent {
  source: 'aws.amplify';
  'detail-type': 'Amplify Deployment Status Change';
  time: string;
  detail: {
    appId: string;
    branchName: string;
    jobId: string;
    jobStatus: 'SUCCEED' | 'FAILED' | 'STARTED' | 'RUNNING' | string;
  };
}

interface CloudFormationStackEvent {
  source: 'aws.cloudformation';
  'detail-type': 'CloudFormation Stack Status Change';
  time: string;
  resources: string[];  // [stack ARN]
  detail: {
    'stack-id': string;
    'status-details': {
      status: string;
      'status-reason'?: string;
    };
  };
}

type DeployEvent = AmplifyDeploymentEvent | CloudFormationStackEvent;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(isoTime: string): string {
  return new Date(isoTime).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

/** Extract a short stack name from a CloudFormation stack ARN or stack-id */
function stackNameFromId(stackId: string): string {
  // arn:aws:cloudformation:us-east-1:617117175946:stack/Briefings-Generator-prod/uuid
  const match = stackId.match(/stack\/([^/]+)\//);
  return match ? match[1] : stackId;
}

// ---------------------------------------------------------------------------
// Slack payload builders
// ---------------------------------------------------------------------------

function buildAmplifyPayload(event: AmplifyDeploymentEvent): object {
  const { branchName, jobId, jobStatus, appId } = event.detail;
  const time = formatTime(event.time);

  const isSuccess = jobStatus === 'SUCCEED';
  const emoji = isSuccess ? '🚀' : '💥';
  const verb  = isSuccess ? 'Deployment succeeded' : 'Deployment FAILED';

  // Map branch → environment label
  const envLabel = branchName === 'main' ? 'prod' : branchName === 'dev' ? 'dev' : branchName;
  const buildUrl =
    `https://us-east-1.console.aws.amazon.com/amplify/home?region=us-east-1` +
    `#/${appId}/${branchName}/${jobId}`;

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${verb} — ${envLabel}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*Branch*\n\`${branchName}\`` },
          { type: 'mrkdwn', text: `*Environment*\n${envLabel}` },
          { type: 'mrkdwn', text: `*Status*\n${jobStatus}` },
          { type: 'mrkdwn', text: `*Job*\n#${jobId}` },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🕐 ${time} ET  ·  <${buildUrl}|View build>  ·  Amplify CI/CD`,
          },
        ],
      },
    ],
  };
}

function buildCloudFormationPayload(event: CloudFormationStackEvent): object {
  const stackId = event.detail['stack-id'];
  const status  = event.detail['status-details'].status;
  const reason  = event.detail['status-details']['status-reason'];
  const stackName = stackNameFromId(stackId);
  const time = formatTime(event.time);

  const isSuccess  = ['UPDATE_COMPLETE', 'CREATE_COMPLETE', 'IMPORT_COMPLETE'].includes(status);
  const isRollback = status.includes('ROLLBACK') || status.includes('FAILED');
  const emoji = isSuccess ? '📦' : isRollback ? '⏪' : '⚠️';

  const cfConsoleUrl =
    `https://us-east-1.console.aws.amazon.com/cloudformation/home?region=us-east-1` +
    `#/stacks/stackinfo?stackId=${encodeURIComponent(stackId)}`;

  const fields: object[] = [
    { type: 'mrkdwn', text: `*Stack*\n\`${stackName}\`` },
    { type: 'mrkdwn', text: `*Status*\n${status}` },
  ];
  if (reason) {
    fields.push({ type: 'mrkdwn', text: `*Reason*\n${reason}` });
  }

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} ${stackName} — ${status}`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields,
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🕐 ${time} ET  ·  <${cfConsoleUrl}|View stack>  ·  CloudFormation`,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------
export async function handler(event: DeployEvent): Promise<void> {
  console.log('[deploy-notifier] Event:', JSON.stringify(event));

  const webhookUrl = await getWebhookUrl();

  let payload: object;
  if (event.source === 'aws.amplify') {
    payload = buildAmplifyPayload(event as AmplifyDeploymentEvent);
  } else if (event.source === 'aws.cloudformation') {
    payload = buildCloudFormationPayload(event as CloudFormationStackEvent);
  } else {
    console.warn('[deploy-notifier] Unknown event source, skipping');
    return;
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok || text !== 'ok') {
    throw new Error(`Slack webhook error [${res.status}]: ${text}`);
  }

  console.log('[deploy-notifier] ✅ Posted to Slack');
}
