/**
 * BriefingsHostingStack
 *
 * Creates:
 *  - Private S3 bucket (versioning enabled, no public access)
 *  - CloudFront Origin Access Control (OAC)
 *  - CloudFront distribution
 *      • Origin: S3 via OAC
 *      • Default root object: index.html
 *      • Custom 404 → 200 /index.html (SPA fallback)
 *      • index.html + manifest.json: short TTL (60s)
 *      • /YYYY/* paths: long TTL (immutable)
 *      • Custom domain with ACM cert (us-east-1)
 *  - ACM certificate (DNS validated via Route53)
 *  - Route53 A+AAAA alias records → CloudFront
 *
 * Outputs:
 *  - BucketName
 *  - DistributionId
 *  - DistributionDomain
 *  - SiteUrl
 */

import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface BriefingsHostingStackProps extends cdk.StackProps {
  envName: string;
  customDomain: string;
  hostedZoneDomainName: string;
  hostedZoneId: string;
}

export class BriefingsHostingStack extends cdk.Stack {
  public readonly bucketName: string;
  public readonly distributionId: string;

  constructor(scope: Construct, id: string, props: BriefingsHostingStackProps) {
    super(scope, id, props);

    const { envName, customDomain, hostedZoneDomainName, hostedZoneId } = props;

    // -------------------------------------------------------------------------
    // S3 Bucket
    // -------------------------------------------------------------------------
    const bucket = new s3.Bucket(this, 'BriefingsBucket', {
      bucketName: `sdn-briefings-${envName}`,
      versioned: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      publicReadAccess: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // CORS is not needed — CloudFront + same-origin fetches only
    });

    this.bucketName = bucket.bucketName;

    // -------------------------------------------------------------------------
    // ACM Certificate (DNS validated — Route53 auto-validates)
    // -------------------------------------------------------------------------
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, 'HostedZone', {
      hostedZoneId,
      zoneName: hostedZoneDomainName,
    });

    const certificate = new acm.Certificate(this, 'Certificate', {
      domainName: customDomain,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // -------------------------------------------------------------------------
    // CloudFront OAC
    // -------------------------------------------------------------------------
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: `OAC for sdn-briefings-${envName}`,
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    });

    // -------------------------------------------------------------------------
    // CloudFront Distribution
    // -------------------------------------------------------------------------
    // Short-TTL cache policy for index.html and manifest.json
    const shortTtlPolicy = new cloudfront.CachePolicy(this, 'ShortTtlPolicy', {
      cachePolicyName: `briefings-short-ttl-${envName}`,
      comment: 'index.html and manifest.json — 60s TTL',
      defaultTtl: cdk.Duration.seconds(60),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(300),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    // Long-TTL (immutable) cache policy for dated briefing files
    const immutablePolicy = new cloudfront.CachePolicy(this, 'ImmutablePolicy', {
      cachePolicyName: `briefings-immutable-${envName}`,
      comment: 'Dated briefing HTML — effectively immutable',
      defaultTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    });

    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(bucket, {
      originAccessControl: oac,
    });

    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `sdn-briefings-${envName}`,
      defaultRootObject: 'index.html',
      domainNames: [customDomain],
      certificate,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,

      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: shortTtlPolicy,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        compress: true,
      },

      additionalBehaviors: {
        // Dated briefing HTML files — long TTL (/2026/04/01-0800.html etc.)
        '/20*/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutablePolicy,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          compress: true,
        },
      },

      // SPA fallback: 404 from S3 → serve index.html with 200
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
    });

    this.distributionId = distribution.distributionId;

    // -------------------------------------------------------------------------
    // Bucket policy — allow CloudFront OAC to read
    // -------------------------------------------------------------------------
    bucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudFrontOAC',
      effect: iam.Effect.ALLOW,
      principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
      actions: ['s3:GetObject'],
      resources: [`${bucket.bucketArn}/*`],
      conditions: {
        StringEquals: {
          'AWS:SourceArn': `arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`,
        },
      },
    }));

    // -------------------------------------------------------------------------
    // Route53 DNS records
    // -------------------------------------------------------------------------
    const cfTarget = new targets.CloudFrontTarget(distribution);

    new route53.ARecord(this, 'AliasA', {
      zone: hostedZone,
      recordName: customDomain,
      target: route53.RecordTarget.fromAlias(cfTarget),
    });

    new route53.AaaaRecord(this, 'AliasAAAA', {
      zone: hostedZone,
      recordName: customDomain,
      target: route53.RecordTarget.fromAlias(cfTarget),
    });

    // -------------------------------------------------------------------------
    // CloudFormation Outputs
    // -------------------------------------------------------------------------
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'S3 bucket for briefings content',
      exportName: `Briefings-${envName}-BucketName`,
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      description: 'CloudFront distribution ID',
      exportName: `Briefings-${envName}-DistributionId`,
    });

    new cdk.CfnOutput(this, 'DistributionDomain', {
      value: distribution.distributionDomainName,
      description: 'CloudFront distribution domain name',
      exportName: `Briefings-${envName}-DistributionDomain`,
    });

    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${customDomain}`,
      description: `Live URL for ${envName} environment`,
      exportName: `Briefings-${envName}-SiteUrl`,
    });
  }
}
