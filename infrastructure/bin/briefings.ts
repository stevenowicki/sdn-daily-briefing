#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { BriefingsHostingStack } from '../lib/briefings-hosting-stack';
import { BriefingsCiStack } from '../lib/briefings-ci-stack';

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
