/**
 * BriefingsCiStack
 *
 * Configures AWS Amplify as a CI/CD runner (NOT as a hosting platform).
 * On every push to `main` or `dev`, Amplify:
 *   1. Runs `npm ci` inside infrastructure/
 *   2. Runs `cdk deploy` for the appropriate env stack
 *   3. Copies the compiled index.html to the correct S3 bucket
 *
 * A single Amplify app handles both branches so both environments share
 * one GitHub webhook.
 *
 * Amplify does not serve any content — CloudFront (managed by BriefingsHostingStack)
 * is the actual CDN for both environments.
 *
 * Outputs:
 *  - AmplifyAppId
 */

import * as cdk from 'aws-cdk-lib';
import * as amplify from 'aws-cdk-lib/aws-amplify';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

export interface BriefingsCiStackProps extends cdk.StackProps {
  /** CloudFront distribution ID for the prod environment (used in build spec) */
  prodDistributionId: string;
  /** S3 bucket name for the prod environment */
  prodBucketName: string;
}

export class BriefingsCiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: BriefingsCiStackProps) {
    super(scope, id, props);

    const { prodDistributionId, prodBucketName } = props;

    // -------------------------------------------------------------------------
    // Read GitHub token from SSM
    // -------------------------------------------------------------------------
    const githubOauthToken = ssm.StringParameter.valueForStringParameter(
      this,
      '/briefings/github-oauth-token',
    );

    // -------------------------------------------------------------------------
    // IAM Role for Amplify
    // Needs permission to: call CDK (CloudFormation, S3, ACM, CloudFront,
    // Route53, IAM), upload to S3 buckets, and create CloudFront invalidations.
    // -------------------------------------------------------------------------
    const amplifyRole = new iam.Role(this, 'AmplifyServiceRole', {
      roleName: 'Briefings-AmplifyServiceRole',
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify'),
      ],
    });

    // Allow Amplify build to assume a role that can do CDK deploys + S3 ops.
    // We grant AdministratorAccess for simplicity (personal project, no risk).
    amplifyRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['sts:AssumeRole'],
      resources: [`arn:aws:iam::${this.account}:role/cdk-*`],
    }));

    // -------------------------------------------------------------------------
    // Build Spec
    //
    // The build spec uses the CDK CLI to deploy the appropriate stack based on
    // the branch name, then uploads index.html to S3 and invalidates CloudFront.
    //
    // Branch mapping:
    //   main → env=prod
    //   dev  → env=dev
    //
    // Environment variables injected by Amplify at build time:
    //   AWS_BRANCH     — Amplify sets this automatically to the branch name
    //   AWS_ACCOUNT_ID — Amplify sets this automatically
    // -------------------------------------------------------------------------
    const buildSpec = `version: 1
frontend:
  phases:
    preBuild:
      commands:
        - echo "Branch: $AWS_BRANCH"
        - export DEPLOY_ENV=$([ "$AWS_BRANCH" = "main" ] && echo "prod" || echo "dev")
        - echo "Deploying env=$DEPLOY_ENV"
        - cd infrastructure
        - npm ci
    build:
      commands:
        - npx cdk deploy Briefings-Hosting-$DEPLOY_ENV --require-approval never --context env=$DEPLOY_ENV
        - export BUCKET_NAME=$(aws cloudformation describe-stacks --stack-name Briefings-Hosting-$DEPLOY_ENV --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text --region us-east-1)
        - export DIST_ID=$(aws cloudformation describe-stacks --stack-name Briefings-Hosting-$DEPLOY_ENV --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text --region us-east-1)
        - echo "Uploading index.html to s3://$BUCKET_NAME"
        - aws s3 cp ../src/index.html s3://$BUCKET_NAME/index.html --content-type text/html --cache-control "max-age=60"
        - echo "Invalidating CloudFront cache for $DIST_ID"
        - aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/index.html" --region us-east-1
  artifacts:
    baseDirectory: /dev/null
    files:
      - '**/*'
`;

    // -------------------------------------------------------------------------
    // Amplify App
    // -------------------------------------------------------------------------
    const amplifyApp = new amplify.CfnApp(this, 'AmplifyApp', {
      name: 'Briefings-CI',
      description: 'CI/CD runner for sdn-daily-briefing — deploys CDK on git push',

      repository: 'https://github.com/stevenowicki/sdn-daily-briefing',
      oauthToken: githubOauthToken,

      iamServiceRole: amplifyRole.roleArn,

      buildSpec,

      // Static platform — Amplify is CI-only, no hosting
      platform: 'WEB',

      environmentVariables: [
        { name: 'PROD_BUCKET_NAME', value: prodBucketName },
        { name: 'PROD_DISTRIBUTION_ID', value: prodDistributionId },
      ],

      enableBranchAutoDeletion: false,
    });

    // -------------------------------------------------------------------------
    // Amplify Branches
    // -------------------------------------------------------------------------
    const mainBranch = new amplify.CfnBranch(this, 'MainBranch', {
      appId: amplifyApp.attrAppId,
      branchName: 'main',
      description: 'Production branch — deploys to briefings.stevenowicki.com',
      enableAutoBuild: true,
      stage: 'PRODUCTION',
      environmentVariables: [
        { name: 'DEPLOY_ENV', value: 'prod' },
      ],
    });
    mainBranch.addDependency(amplifyApp);

    const devBranch = new amplify.CfnBranch(this, 'DevBranch', {
      appId: amplifyApp.attrAppId,
      branchName: 'dev',
      description: 'Dev branch — deploys to dev.briefings.stevenowicki.com',
      enableAutoBuild: true,
      stage: 'DEVELOPMENT',
      environmentVariables: [
        { name: 'DEPLOY_ENV', value: 'dev' },
      ],
    });
    devBranch.addDependency(amplifyApp);

    // -------------------------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: amplifyApp.attrAppId,
      description: 'Amplify CI app ID',
      exportName: 'Briefings-CI-AmplifyAppId',
    });
  }
}
