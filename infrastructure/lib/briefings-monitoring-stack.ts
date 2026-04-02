/**
 * BriefingsMonitoringStack
 *
 * Resources created:
 *
 *  CloudWatch Dashboard: Briefings-{env}
 *    Sections: Generator Lambda · Claude API (custom metrics) ·
 *              Notification Pipelines · Queue Health (DLQs) ·
 *              Frontend/CDN · EventBridge Scheduler · Alarm Status
 *
 *  CloudWatch Alarms (9 total):
 *    - briefings-generator-errors-{env}       Generator Lambda errors > 0
 *    - briefings-generator-duration-{env}     p99 duration > 9 min (of 10 min timeout)
 *    - briefings-generator-throttles-{env}    Throttles > 0
 *    - briefings-pushover-errors-{env}        Pushover Lambda errors > 0
 *    - briefings-slack-errors-{env}           Slack Lambda errors > 0
 *    - briefings-pushover-dlq-{env}           Pushover DLQ depth ≥ 1
 *    - briefings-slack-dlq-{env}              Slack DLQ depth ≥ 1
 *    - briefings-cloudfront-5xx-{env}         CloudFront 5xx rate > 1%
 *    - briefings-scheduler-dropped-{env}      EventBridge dropped a scheduled invocation
 *
 *  Alarm Notification Pipeline:
 *    SNS Topic: briefings-alarms-{env}
 *    Lambda:    briefings-alarm-notifier-{env}  (posts to Slack on state change)
 *
 *  Custom Metrics (namespace: Briefings):
 *    Emitted by the generator Lambda on each run:
 *    - ClaudeCallDurationMs   Time for the Anthropic API call (ms)
 *    - ClaudeInputTokens      Prompt tokens consumed
 *    - ClaudeOutputTokens     Completion tokens generated
 *    - BriefingHtmlBytes      Size of the generated HTML document (bytes)
 *    - BriefingSuccess        1 on every successful end-to-end run
 *    Dimensions: Environment={env}, Label={Morning|Evening|Late Night}
 */

import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as path from 'path';
import { Construct } from 'constructs';

export interface BriefingsMonitoringStackProps extends cdk.StackProps {
  envName: string;
  distributionId: string;
}

export class BriefingsMonitoringStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BriefingsMonitoringStackProps) {
    super(scope, id, props);

    const { envName, distributionId } = props;

    // Predictable resource names — no cross-stack references needed
    const genFn       = `briefings-generator-${envName}`;
    const pushoverFn  = `briefings-pushover-notifier-${envName}`;
    const slackFn     = `briefings-slack-notifier-${envName}`;
    const pushoverQ   = `briefings-pushover-queue-${envName}`;
    const pushoverDlq = `briefings-pushover-dlq-${envName}`;
    const slackQ      = `briefings-slack-queue-${envName}`;
    const slackDlq    = `briefings-slack-dlq-${envName}`;
    const snsName     = `briefings-generated-${envName}`;
    const dashName    = `Briefings-${envName}`;

    // -----------------------------------------------------------------------
    // Metric factories
    // -----------------------------------------------------------------------
    const lm = (fn: string, metric: string, stat: string, period = cdk.Duration.minutes(5)) =>
      new cloudwatch.Metric({ namespace: 'AWS/Lambda', metricName: metric,
        dimensionsMap: { FunctionName: fn }, statistic: stat, period });

    const sqm = (q: string, metric: string, stat: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/SQS', metricName: metric,
        dimensionsMap: { QueueName: q }, statistic: stat, period: cdk.Duration.minutes(1) });

    const snm = (metric: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/SNS', metricName: metric,
        dimensionsMap: { TopicName: snsName }, statistic: 'Sum', period: cdk.Duration.minutes(5) });

    const cfm = (metric: string, stat: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/CloudFront', metricName: metric,
        dimensionsMap: { DistributionId: distributionId, Region: 'Global' },
        statistic: stat, period: cdk.Duration.minutes(5) });

    const schm = (metric: string) =>
      new cloudwatch.Metric({ namespace: 'AWS/Scheduler', metricName: metric,
        statistic: 'Sum', period: cdk.Duration.hours(1) });

    // Custom metrics emitted by the generator Lambda (namespace: Briefings)
    const bm = (metric: string, stat: string, period = cdk.Duration.hours(1)) =>
      new cloudwatch.Metric({ namespace: 'Briefings', metricName: metric,
        dimensionsMap: { Environment: envName }, statistic: stat, period });

    // -----------------------------------------------------------------------
    // Alarm notification pipeline: SNS → Lambda → Slack
    // -----------------------------------------------------------------------
    const alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `briefings-alarms-${envName}`,
      displayName: `Briefings Alarms (${envName})`,
    });

    const alarmLambda = new lambdaNode.NodejsFunction(this, 'AlarmLambda', {
      functionName: `briefings-alarm-notifier-${envName}`,
      description: 'Forwards CloudWatch alarm state changes to Slack',
      entry: path.join(__dirname, '../../lambdas/briefing-alarms/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: {
        SSM_SLACK_WEBHOOK_URL: '/briefings/slack-webhook-url',
        DASHBOARD_NAME: dashName,
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

    alarmTopic.addSubscription(new snsSubscriptions.LambdaSubscription(alarmLambda));

    alarmLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['ssm:GetParameter'],
      resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/briefings/slack-webhook-url`],
    }));
    alarmLambda.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['kms:Decrypt'],
      resources: ['arn:aws:kms:*:*:alias/aws/ssm'],
    }));

    // -----------------------------------------------------------------------
    // Alarms
    // -----------------------------------------------------------------------
    const mkAlarm = (id: string, p: cloudwatch.AlarmProps) => {
      const alarm = new cloudwatch.Alarm(this, id, p);
      alarm.addAlarmAction(new cwActions.SnsAction(alarmTopic));
      alarm.addOkAction(new cwActions.SnsAction(alarmTopic));
      return alarm;
    };

    const generatorErrorAlarm = mkAlarm('GeneratorErrors', {
      alarmName: `briefings-generator-errors-${envName}`,
      alarmDescription: 'Generator Lambda errors > 0 — a briefing likely failed to generate',
      metric: lm(genFn, 'Errors', 'Sum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const generatorDurationAlarm = mkAlarm('GeneratorDuration', {
      alarmName: `briefings-generator-duration-${envName}`,
      alarmDescription: 'Generator p99 duration > 9 min — approaching the 10-minute Lambda timeout',
      metric: lm(genFn, 'Duration', 'p99', cdk.Duration.hours(1)),
      threshold: 540_000,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const generatorThrottleAlarm = mkAlarm('GeneratorThrottles', {
      alarmName: `briefings-generator-throttles-${envName}`,
      alarmDescription: 'Generator Lambda was throttled by AWS — concurrent execution limit reached',
      metric: lm(genFn, 'Throttles', 'Sum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const pushoverErrorAlarm = mkAlarm('PushoverErrors', {
      alarmName: `briefings-pushover-errors-${envName}`,
      alarmDescription: 'Pushover notifier Lambda errors > 0 — iPhone notification may not have been sent',
      metric: lm(pushoverFn, 'Errors', 'Sum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const slackErrorAlarm = mkAlarm('SlackErrors', {
      alarmName: `briefings-slack-errors-${envName}`,
      alarmDescription: 'Slack notifier Lambda errors > 0 — Slack notification may not have been sent',
      metric: lm(slackFn, 'Errors', 'Sum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const pushoverDlqAlarm = mkAlarm('PushoverDLQDepth', {
      alarmName: `briefings-pushover-dlq-${envName}`,
      alarmDescription: 'Pushover DLQ depth ≥ 1 — a notification failed all 3 delivery attempts',
      metric: sqm(pushoverDlq, 'ApproximateNumberOfMessagesVisible', 'Maximum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const slackDlqAlarm = mkAlarm('SlackDLQDepth', {
      alarmName: `briefings-slack-dlq-${envName}`,
      alarmDescription: 'Slack DLQ depth ≥ 1 — a notification failed all 3 delivery attempts',
      metric: sqm(slackDlq, 'ApproximateNumberOfMessagesVisible', 'Maximum'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const cf5xxAlarm = mkAlarm('CloudFront5xx', {
      alarmName: `briefings-cloudfront-5xx-${envName}`,
      alarmDescription: 'CloudFront 5xx error rate > 1% (2 of 3 periods) — site may be unavailable',
      metric: cfm('5xxErrorRate', 'Average'),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const schedulerDroppedAlarm = mkAlarm('SchedulerDropped', {
      alarmName: `briefings-scheduler-dropped-${envName}`,
      alarmDescription: 'EventBridge Scheduler dropped a briefing invocation — a scheduled run was missed',
      metric: schm('InvocationDroppedCount'),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const allAlarms = [
      generatorErrorAlarm, generatorDurationAlarm, generatorThrottleAlarm,
      pushoverErrorAlarm, slackErrorAlarm,
      pushoverDlqAlarm, slackDlqAlarm,
      cf5xxAlarm, schedulerDroppedAlarm,
    ];

    // -----------------------------------------------------------------------
    // Dashboard
    // -----------------------------------------------------------------------
    const dash = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: dashName,
      defaultInterval: cdk.Duration.days(7),
    });

    const h1 = (text: string) =>
      new cloudwatch.TextWidget({ markdown: text, width: 24, height: 1 });

    const RED   = '#d13212';
    const threshold1 = (label = 'Failure threshold'): cloudwatch.HorizontalAnnotation[] =>
      [{ value: 1, label, color: RED, fill: cloudwatch.Shading.ABOVE }];

    // --- Header ---
    dash.addWidgets(new cloudwatch.TextWidget({
      markdown:
        `# 📰 Briefings Operations — ${envName.toUpperCase()}\n` +
        `3 briefings/day at **8am · 5:30pm · 11pm ET**  ·  ` +
        `[Dashboard](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=${dashName})  ·  ` +
        `[Generator logs](https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#logsV2:log-groups/log-group/$252Faws$252Flambda$252F${genFn})`,
      width: 24,
      height: 2,
    }));

    // --- Alarm status overview ---
    dash.addWidgets(new cloudwatch.AlarmStatusWidget({
      title: '🚨 Alarm Status',
      alarms: allAlarms,
      width: 24,
      height: 4,
    }));

    // ===================================================================
    // Section: Briefing Generator
    // ===================================================================
    dash.addWidgets(h1('## ⚡ Briefing Generator Lambda'));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Invocations & Errors',
        left:  [lm(genFn, 'Invocations', 'Sum')],
        right: [lm(genFn, 'Errors', 'Sum')],
        leftYAxis:  { label: 'Invocations', min: 0, showUnits: false },
        rightYAxis: { label: 'Errors',      min: 0, showUnits: false },
        rightAnnotations: threshold1('Error threshold'),
        width: 12, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Duration — p50 / p95 / p99 / max (ms)',
        left: [
          lm(genFn, 'Duration', 'p50',     cdk.Duration.hours(1)),
          lm(genFn, 'Duration', 'p95',     cdk.Duration.hours(1)),
          lm(genFn, 'Duration', 'p99',     cdk.Duration.hours(1)),
          lm(genFn, 'Duration', 'Maximum', cdk.Duration.hours(1)),
        ],
        leftAnnotations: [{ value: 540_000, label: '9 min warn', color: '#ff9900' },
                          { value: 600_000, label: '10 min timeout', color: RED }],
        leftYAxis: { label: 'ms', min: 0, showUnits: false },
        width: 12, height: 6,
      }),
    );

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Throttles & Concurrent Executions',
        left: [
          lm(genFn, 'Throttles',            'Sum',     cdk.Duration.minutes(5)),
          lm(genFn, 'ConcurrentExecutions', 'Maximum', cdk.Duration.minutes(5)),
        ],
        leftYAxis: { label: 'Count', min: 0, showUnits: false },
        width: 12, height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Briefing HTML Size (bytes)',
        left: [
          bm('BriefingHtmlBytes', 'Average'),
          bm('BriefingHtmlBytes', 'Maximum'),
        ],
        leftYAxis: { label: 'bytes', min: 0, showUnits: false },
        width: 12, height: 4,
      }),
    );

    // ===================================================================
    // Section: Claude API
    // ===================================================================
    dash.addWidgets(h1('## 🤖 Claude API Performance (custom metrics)'));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Claude Call Duration — avg / p95 / max (ms)',
        left: [
          bm('ClaudeCallDurationMs', 'Average'),
          bm('ClaudeCallDurationMs', 'p95'),
          bm('ClaudeCallDurationMs', 'Maximum'),
        ],
        leftYAxis: { label: 'ms', min: 0, showUnits: false },
        width: 8, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Input Tokens (prompt)',
        left: [
          bm('ClaudeInputTokens', 'Average'),
          bm('ClaudeInputTokens', 'Maximum'),
          bm('ClaudeInputTokens', 'Sum'),
        ],
        leftYAxis: { label: 'tokens', min: 0, showUnits: false },
        width: 8, height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Output Tokens (completion)',
        left: [
          bm('ClaudeOutputTokens', 'Average'),
          bm('ClaudeOutputTokens', 'Maximum'),
          bm('ClaudeOutputTokens', 'Sum'),
        ],
        leftYAxis: { label: 'tokens', min: 0, showUnits: false },
        width: 8, height: 6,
      }),
    );

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Successful Briefings Generated',
        left: [bm('BriefingSuccess', 'Sum')],
        leftYAxis: { label: 'count', min: 0, showUnits: false },
        width: 8, height: 4,
      }),
      new cloudwatch.GraphWidget({
        title: 'Total Tokens Used (input + output)',
        left: [
          bm('ClaudeInputTokens',  'Sum'),
          bm('ClaudeOutputTokens', 'Sum'),
        ],
        leftYAxis: { label: 'tokens', min: 0, showUnits: false },
        width: 16, height: 4,
      }),
    );

    // ===================================================================
    // Section: Notification Pipelines
    // ===================================================================
    dash.addWidgets(h1('## 📬 Notification Pipelines'));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pushover — Invocations & Errors',
        left:  [lm(pushoverFn, 'Invocations', 'Sum')],
        right: [lm(pushoverFn, 'Errors', 'Sum')],
        leftYAxis:  { label: 'Invocations', min: 0, showUnits: false },
        rightYAxis: { label: 'Errors',      min: 0, showUnits: false },
        rightAnnotations: threshold1(),
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Slack — Invocations & Errors',
        left:  [lm(slackFn, 'Invocations', 'Sum')],
        right: [lm(slackFn, 'Errors', 'Sum')],
        leftYAxis:  { label: 'Invocations', min: 0, showUnits: false },
        rightYAxis: { label: 'Errors',      min: 0, showUnits: false },
        rightAnnotations: threshold1(),
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'SNS — Published / Delivered / Failed',
        left: [
          snm('NumberOfMessagesPublished'),
          snm('NumberOfNotificationsDelivered'),
          snm('NumberOfNotificationsFailed'),
        ],
        leftYAxis: { label: 'count', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
    );

    // ===================================================================
    // Section: Queue Health (DLQs most critical)
    // ===================================================================
    dash.addWidgets(new cloudwatch.TextWidget({
      markdown: '## 🔴 Queue Health\n_Any message in a DLQ means a notification exhausted all retries. Should always be 0._',
      width: 24, height: 2,
    }));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Pushover Queue Depth',
        left: [
          sqm(pushoverQ, 'ApproximateNumberOfMessagesVisible',    'Maximum'),
          sqm(pushoverQ, 'ApproximateNumberOfMessagesNotVisible', 'Maximum'),
        ],
        leftYAxis: { label: 'messages', min: 0, showUnits: false },
        width: 6, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: '🚨 Pushover DLQ',
        left: [sqm(pushoverDlq, 'ApproximateNumberOfMessagesVisible', 'Maximum')],
        leftAnnotations: threshold1(),
        leftYAxis: { label: 'messages', min: 0, showUnits: false },
        width: 6, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Slack Queue Depth',
        left: [
          sqm(slackQ, 'ApproximateNumberOfMessagesVisible',    'Maximum'),
          sqm(slackQ, 'ApproximateNumberOfMessagesNotVisible', 'Maximum'),
        ],
        leftYAxis: { label: 'messages', min: 0, showUnits: false },
        width: 6, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: '🚨 Slack DLQ',
        left: [sqm(slackDlq, 'ApproximateNumberOfMessagesVisible', 'Maximum')],
        leftAnnotations: threshold1(),
        leftYAxis: { label: 'messages', min: 0, showUnits: false },
        width: 6, height: 5,
      }),
    );

    // ===================================================================
    // Section: Frontend / CDN
    // ===================================================================
    dash.addWidgets(h1('## 🌐 Frontend / CDN (CloudFront)'));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Requests',
        left: [cfm('Requests', 'Sum')],
        leftYAxis: { label: 'requests', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Error Rates (%)',
        left: [
          cfm('4xxErrorRate',    'Average'),
          cfm('5xxErrorRate',    'Average'),
          cfm('TotalErrorRate',  'Average'),
        ],
        leftAnnotations: [{ value: 1, label: '1% warn', color: '#ff9900' },
                          { value: 5, label: '5% critical', color: RED }],
        leftYAxis: { label: '%', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Data Transferred (bytes)',
        left: [cfm('BytesDownloaded', 'Sum')],
        leftYAxis: { label: 'bytes', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
    );

    // ===================================================================
    // Section: EventBridge Scheduler
    // ===================================================================
    dash.addWidgets(h1('## 📅 EventBridge Scheduler'));

    dash.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Invocation Attempts',
        left: [schm('InvocationAttemptCount')],
        leftYAxis: { label: 'count', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: '🚨 Dropped / Failed Invocations',
        left: [
          schm('InvocationDroppedCount'),
          schm('TargetErrorCount'),
        ],
        leftAnnotations: threshold1(),
        leftYAxis: { label: 'count', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
      new cloudwatch.GraphWidget({
        title: 'Throttled Invocations',
        left: [schm('InvocationThrottleCount')],
        leftAnnotations: threshold1(),
        leftYAxis: { label: 'count', min: 0, showUnits: false },
        width: 8, height: 5,
      }),
    );

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://us-east-1.console.aws.amazon.com/cloudwatch/home?region=us-east-1#dashboards:name=${dashName}`,
      description: `CloudWatch dashboard — ${envName}`,
    });

    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: alarmTopic.topicArn,
      description: 'SNS topic for CloudWatch alarm notifications',
    });
  }
}
