#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BriefingsHostingStack } from '../lib/briefings-hosting-stack';
import { BriefingsCiStack } from '../lib/briefings-ci-stack';
import { BriefingsGeneratorStack } from '../lib/briefings-generator-stack';
import { BriefingsMonitoringStack } from '../lib/briefings-monitoring-stack';

const app = new cdk.App();

// Resolve environment from context: `cdk deploy --context env=prod` or `env=dev`
const envName = (app.node.tryGetContext('env') as string) ?? 'prod';
if (!['prod', 'dev'].includes(envName)) {
  throw new Error(`Invalid env context: '${envName}'. Must be 'prod' or 'dev'.`);
}

const isProd = envName === 'prod';

// All stacks live in us-east-1 so that CloudFront can use the ACM certificate
// directly (CloudFront requires certs in us-east-1).
const env: cdk.Environment = {
  account: process.env.CDK_DEFAULT_ACCOUNT ?? '617117175946',
  region: 'us-east-1',
};

// ---------------------------------------------------------------------------
// Hosting stack: S3 bucket + CloudFront + OAC + ACM certificate + Route53
// ---------------------------------------------------------------------------
const hostingStack = new BriefingsHostingStack(app, `Briefings-Hosting-${envName}`, {
  envName,
  customDomain: isProd ? 'briefings.stevenowicki.com' : 'dev.briefings.stevenowicki.com',
  hostedZoneDomainName: 'stevenowicki.com',
  hostedZoneId: 'ZOSJEODV7MORU',
  env,
  tags: {
    Project: 'Briefings',
    Environment: envName,
    ManagedBy: 'CDK',
  },
});

// ---------------------------------------------------------------------------
// Generator stack: Lambda + EventBridge schedules + SNS fan-out + Pushover
// Schedules are only enabled in prod; dev can invoke the Lambda manually.
// ---------------------------------------------------------------------------
new BriefingsGeneratorStack(app, `Briefings-Generator-${envName}`, {
  envName,
  bucketName: hostingStack.bucketName,
  distributionId: hostingStack.distributionId,
  siteUrl: isProd ? 'https://briefings.stevenowicki.com' : 'https://dev.briefings.stevenowicki.com',
  enableSchedules: isProd,
  env,
  tags: {
    Project: 'Briefings',
    Environment: envName,
    ManagedBy: 'CDK',
  },
});

// ---------------------------------------------------------------------------
// Monitoring stack: CloudWatch dashboard + alarms + alarm-notifier Lambda
// Only deploy for prod — dev has no live schedules or meaningful traffic.
// ---------------------------------------------------------------------------
if (isProd) {
  new BriefingsMonitoringStack(app, 'Briefings-Monitoring', {
    envName,
    distributionId: hostingStack.distributionId,
    env,
    tags: {
      Project: 'Briefings',
      Environment: envName,
      ManagedBy: 'CDK',
    },
  });
}

// ---------------------------------------------------------------------------
// CI stack: Amplify app + branches (only deploy the CI stack for prod so that
// a single Amplify app handles both main→prod and dev→dev).
// ---------------------------------------------------------------------------
if (isProd) {
  new BriefingsCiStack(app, 'Briefings-CI', {
    prodDistributionId: hostingStack.distributionId,
    prodBucketName: hostingStack.bucketName,
    env,
    tags: {
      Project: 'Briefings',
      ManagedBy: 'CDK',
    },
  });
}

app.synth();
