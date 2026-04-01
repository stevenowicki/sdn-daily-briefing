/**
 * BriefingsGeneratorStack
 *
 * Resources created:
 *
 *  Compute
 *  -------
 *  - Lambda: briefing-generator
 *      Triggered on schedule; fetches news/weather/markets, calls Claude,
 *      uploads HTML to S3, updates manifest.json, publishes SNS event.
 *      Timeout: 10 min | Memory: 1024 MB | Runtime: Node.js 22
 *
 *  - Lambda: briefing-pushover-notifier
 *      Consumes SQS queue; calls Pushover API to send the push notification.
 *
 *  Event Bus (SNS fan-out)
 *  -----------------------
 *  - SNS Topic: briefings-generated
 *      Published to after each successful briefing.  Payload includes url,
 *      fullUrl, date, label, time, isoTimestamp, summary.
 *
 *  - SQS Queue: briefings-pushover-queue  ← subscribed to SNS topic
 *  - SQS DLQ:   briefings-pushover-dlq    (after 3 failed delivery attempts)
 *
 *  - SQS Queue: briefings-slack-queue     ← subscribed to SNS topic
 *  - SQS DLQ:   briefings-slack-dlq       (after 3 failed delivery attempts)
 *
 *  Future listeners: add an SQS queue + SNS subscription + Lambda.
 *  No changes needed to the generator Lambda.
 *
 *  Scheduling
 *  ----------
 *  - EventBridge Scheduler rules for each entry in BRIEFING_SCHEDULES
 *    All rules run in America/New_York timezone.
 *    Schedules are only activated when enableSchedules=true (prod only).
 *
 *  IAM
 *  ---
 *  - Scheduler execution role: allows invoking the generator Lambda
 *  - Generator Lambda role: S3 r/w on briefings bucket, SNS publish,
 *                           SSM GetParameter (anthropic key)
 *  - Pushover Lambda role: SQS consume, SSM GetParameter (pushover creds)
 *  - Slack Lambda role:   SQS consume, SSM GetParameter (slack webhook url)
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as path from 'path';
import { Construct } from 'constructs';
import { BRIEFING_SCHEDULES } from '../config/briefing-schedules';

export interface BriefingsGeneratorStackProps extends cdk.StackProps {
  envName: string;
  bucketName: string;
  distributionId: string;
  siteUrl: string;
  /** When false, EventBridge Scheduler rules are created but disabled */
  enableSchedules: boolean;
}

export class BriefingsGeneratorStack extends cdk.Stack {
  /** ARN of the SNS topic — handy for adding future listeners */
  public readonly briefingsTopicArn: string;

  constructor(scope: Construct, id: string, props: BriefingsGeneratorStackProps) {
    super(scope, id, props);

    const { envName, bucketName, distributionId, siteUrl, enableSchedules } = props;

    // -----------------------------------------------------------------------
    // SNS Topic — "a briefing was generated"
    // -----------------------------------------------------------------------
    const briefingsTopic = new sns.Topic(this, 'BriefingsTopic', {
      topicName: `briefings-generated-${envName}`,
      displayName: `Briefings Generated (${envName})`,
    });
    this.briefingsTopicArn = briefingsTopic.topicArn;

    // -----------------------------------------------------------------------
    // Pushover SQS Queue  (fan-out subscriber #1)
    // -----------------------------------------------------------------------
    const pushoverDlq = new sqs.Queue(this, 'PushoverDLQ', {
      queueName: `briefings-pushover-dlq-${envName}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const pushoverQueue = new sqs.Queue(this, 'PushoverQueue', {
      queueName: `briefings-pushover-queue-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: pushoverDlq,
        maxReceiveCount: 3,
      },
    });

    // Subscribe the Pushover queue to the SNS topic
    briefingsTopic.addSubscription(new snsSubscriptions.SqsSubscription(pushoverQueue, {
      rawMessageDelivery: true,  // Message body = SNS payload directly (no wrapper)
    }));

    // -----------------------------------------------------------------------
    // Lambda: briefing-generator
    // -----------------------------------------------------------------------
    const generatorLambda = new lambdaNode.NodejsFunction(this, 'GeneratorLambda', {
      functionName: `briefings-generator-${envName}`,
      description: 'Generates daily briefing HTML, uploads to S3, publishes SNS event',
      entry: path.join(__dirname, '../../lambdas/briefing-generator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.minutes(10),
      memorySize: 1024,
      environment: {
        BRIEFINGS_BUCKET_NAME: bucketName,
        BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID: distributionId,
        BRIEFINGS_SITE_URL: siteUrl,
        SNS_TOPIC_ARN: briefingsTopic.topicArn,
        ENV: envName,
        // SSM parameter paths — actual values fetched at runtime
        SSM_ANTHROPIC_API_KEY: '/briefings/anthropic-api-key',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: {
        // AWS SDK v3 is available in Node.js 22 runtime — mark as external
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: true,
        target: 'node22',
        format: lambdaNode.OutputFormat.CJS,
        // Lambda has its own package.json + node_modules — esbuild resolves from there
      },
    });

    // Grant S3 permissions: read existing manifest + write HTML + write manifest
    generatorLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['s3:GetObject', 's3:PutObject'],
      resources: [`arn:aws:s3:::${bucketName}/*`],
    }));

    // Grant CloudFront invalidation permission
    generatorLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['cloudfront:CreateInvalidation'],
      resources: [`arn:aws:cloudfront::${this.account}:distribution/${distributionId}`],
    }));

    // Grant SNS publish
    briefingsTopic.grantPublish(generatorLambda);

    // Grant SSM GetParameter for Anthropic key (SecureString needs kms:Decrypt too)
    generatorLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/briefings/anthropic-api-key`,
      ],
    }));
    generatorLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: ['arn:aws:kms:*:*:alias/aws/ssm'],
    }));

    // -----------------------------------------------------------------------
    // Lambda: briefing-pushover-notifier
    // -----------------------------------------------------------------------
    const pushoverLambda = new lambdaNode.NodejsFunction(this, 'PushoverLambda', {
      functionName: `briefings-pushover-notifier-${envName}`,
      description: 'Sends Pushover push notification when a briefing is generated',
      entry: path.join(__dirname, '../../lambdas/briefing-pushover/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SSM_PUSHOVER_API_TOKEN: '/briefings/pushover-api-token',
        SSM_PUSHOVER_USER_KEY: '/briefings/pushover-user-key',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: true,
        target: 'node22',
        format: lambdaNode.OutputFormat.CJS,
      },
    });

    // Wire the Pushover queue to trigger the Pushover Lambda
    pushoverLambda.addEventSource(new lambdaEventSources.SqsEventSource(pushoverQueue, {
      batchSize: 1,  // One briefing per invocation
      reportBatchItemFailures: true,
    }));

    // Grant SSM GetParameter for Pushover credentials
    pushoverLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/briefings/pushover-api-token`,
        `arn:aws:ssm:${this.region}:${this.account}:parameter/briefings/pushover-user-key`,
      ],
    }));
    pushoverLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: ['arn:aws:kms:*:*:alias/aws/ssm'],
    }));

    // -----------------------------------------------------------------------
    // Slack SQS Queue  (fan-out subscriber #2)
    // -----------------------------------------------------------------------
    const slackDlq = new sqs.Queue(this, 'SlackDLQ', {
      queueName: `briefings-slack-dlq-${envName}`,
      retentionPeriod: cdk.Duration.days(14),
    });

    const slackQueue = new sqs.Queue(this, 'SlackQueue', {
      queueName: `briefings-slack-queue-${envName}`,
      visibilityTimeout: cdk.Duration.seconds(60),
      deadLetterQueue: {
        queue: slackDlq,
        maxReceiveCount: 3,
      },
    });

    // Subscribe the Slack queue to the SNS topic
    briefingsTopic.addSubscription(new snsSubscriptions.SqsSubscription(slackQueue, {
      rawMessageDelivery: true,
    }));

    // -----------------------------------------------------------------------
    // Lambda: briefing-slack-notifier
    // -----------------------------------------------------------------------
    const slackLambda = new lambdaNode.NodejsFunction(this, 'SlackLambda', {
      functionName: `briefings-slack-notifier-${envName}`,
      description: 'Posts a Slack Block Kit message when a briefing is generated',
      entry: path.join(__dirname, '../../lambdas/briefing-slack/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SSM_SLACK_WEBHOOK_URL: '/briefings/slack-webhook-url',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: {
        externalModules: ['@aws-sdk/*'],
        minify: false,
        sourceMap: true,
        target: 'node22',
        format: lambdaNode.OutputFormat.CJS,
      },
    });

    // Wire the Slack queue to trigger the Slack Lambda
    slackLambda.addEventSource(new lambdaEventSources.SqsEventSource(slackQueue, {
      batchSize: 1,
      reportBatchItemFailures: true,
    }));

    // Grant SSM GetParameter for Slack webhook URL
    slackLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [
        `arn:aws:ssm:${this.region}:${this.account}:parameter/briefings/slack-webhook-url`,
      ],
    }));
    slackLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: ['arn:aws:kms:*:*:alias/aws/ssm'],
    }));

    // -----------------------------------------------------------------------
    // EventBridge Scheduler: IAM execution role
    // -----------------------------------------------------------------------
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      roleName: `briefings-scheduler-role-${envName}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    schedulerRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['lambda:InvokeFunction'],
      resources: [generatorLambda.functionArn],
    }));

    // -----------------------------------------------------------------------
    // EventBridge Scheduler rules — one per schedule entry
    // -----------------------------------------------------------------------
    for (const schedule of BRIEFING_SCHEDULES) {
      // Input payload tells the Lambda which briefing this is
      const inputPayload = JSON.stringify({
        briefingName: schedule.name,
        label: schedule.label,
        time: schedule.time,
        emoji: schedule.emoji,
      });

      new scheduler.CfnSchedule(this, `Schedule-${schedule.name}`, {
        name: `briefings-${schedule.name}-${envName}`,
        description: `${schedule.label} briefing — ${schedule.scheduleExpression} ET`,
        scheduleExpression: schedule.scheduleExpression,
        scheduleExpressionTimezone: 'America/New_York',
        state: enableSchedules ? 'ENABLED' : 'DISABLED',
        flexibleTimeWindow: {
          // Allow up to 5-minute flex to reduce cold-start spikes
          mode: 'FLEXIBLE',
          maximumWindowInMinutes: 5,
        },
        target: {
          arn: generatorLambda.functionArn,
          roleArn: schedulerRole.roleArn,
          input: inputPayload,
          retryPolicy: {
            maximumRetryAttempts: 2,
            maximumEventAgeInSeconds: 600,
          },
        },
      });
    }

    // -----------------------------------------------------------------------
    // CloudFormation Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'BriefingsTopicArn', {
      value: briefingsTopic.topicArn,
      description: 'SNS topic ARN for briefings-generated events',
      exportName: `Briefings-${envName}-TopicArn`,
    });

    new cdk.CfnOutput(this, 'GeneratorLambdaArn', {
      value: generatorLambda.functionArn,
      description: 'Briefing generator Lambda ARN',
      exportName: `Briefings-${envName}-GeneratorLambdaArn`,
    });
  }
}
