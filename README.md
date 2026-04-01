# sdn-daily-briefing

Personal news briefing website — **briefings.stevenowicki.com**

Hosts daily morning and evening HTML briefings in a permanent, always-available archive. The index page acts as a news-style home screen; individual briefings are uploaded directly to S3 by the briefing task.

---

## Architecture

| Layer | Technology |
|---|---|
| Content storage | Private S3 bucket (`sdn-briefings-{env}`) |
| CDN | CloudFront with OAC (no public bucket) |
| Custom domain | Route53 alias → CloudFront |
| TLS | ACM certificate (us-east-1, DNS validated) |
| Infrastructure | AWS CDK v2 (TypeScript) |
| CI/CD | AWS Amplify — `main` → prod, `dev` → dev |

### URLs

| Environment | URL |
|---|---|
| Prod | https://briefings.stevenowicki.com |
| Dev | https://dev.briefings.stevenowicki.com |

### S3 structure

```
/index.html
/manifest.json
/2026/04/01-0800.html
/2026/04/01-1730.html
...
```

---

## Development

### Prerequisites

- Node.js 18+
- AWS CLI configured with the `stevenowicki` profile
- CDK bootstrapped in `us-east-1` (already done)

### Deploy infrastructure

```bash
cd infrastructure
npm install

# Deploy prod
npm run deploy:prod

# Deploy dev
npm run deploy:dev
```

### Update index.html locally → prod

```bash
aws s3 cp src/index.html s3://sdn-briefings-prod/index.html \
  --content-type text/html \
  --cache-control "max-age=60" \
  --profile stevenowicki

aws cloudfront create-invalidation \
  --distribution-id <DIST_ID> \
  --paths "/index.html" \
  --profile stevenowicki
```

---

## Briefing Task Integration

After generating a new briefing HTML file, the briefing task should:

### 1. Upload the briefing HTML

```bash
aws s3 cp briefing.html s3://$BRIEFINGS_BUCKET_NAME/2026/04/01-0800.html \
  --content-type text/html \
  --cache-control "max-age=31536000, immutable"
```

### 2. Update manifest.json

```bash
node scripts/update-manifest.js \
  --url /2026/04/01-0800.html \
  --date 2026-04-01 \
  --label Morning \
  --time 08:00 \
  --iso-timestamp 2026-04-01T08:00:00-04:00 \
  --summary "Two to three sentence summary of top stories."
```

### 3. Send Pushover notification

```
title:     ☀️ Morning Briefing — April 1
message:   <2–3 sentence summary>
url:       https://briefings.stevenowicki.com/2026/04/01-0800.html
url_title: Open Morning Briefing
```

### Required environment variables

| Variable | Description |
|---|---|
| `BRIEFINGS_BUCKET_NAME` | S3 bucket — output by CDK (`sdn-briefings-prod`) |
| `BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID` | CloudFront dist ID — output by CDK |

---

## manifest.json schema

```json
{
  "briefings": [
    {
      "url": "/2026/04/01-1730.html",
      "date": "2026-04-01",
      "label": "Evening",
      "time": "17:30",
      "isoTimestamp": "2026-04-01T17:30:00-04:00",
      "summary": "..."
    }
  ]
}
```

---

## CI/CD

Amplify watches `main` and `dev` branches:

- Push to `main` → deploys `Briefings-Hosting-prod` + uploads `index.html`
- Push to `dev` → deploys `Briefings-Hosting-dev` + uploads `index.html`

The `Briefings-CI` Amplify app is itself deployed by CDK as part of the prod stack.
