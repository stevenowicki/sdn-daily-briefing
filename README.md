# sdn-daily-briefing

Personal news briefing website — **briefings.stevenowicki.com**

Three briefings per day (morning, evening, late night) are generated automatically by AWS Lambda, uploaded to a private S3 bucket, and served through CloudFront. The index page is a self-contained SPA that acts as a permanent archive.

---

## Architecture

| Layer | Technology |
|---|---|
| Content storage | Private S3 bucket (`sdn-briefings-{env}`) |
| CDN | CloudFront with OAC (no public bucket) |
| Custom domain | Route53 alias → CloudFront |
| TLS | ACM certificate (us-east-1, DNS validated) |
| Briefing generation | AWS Lambda (`briefings-generator-{env}`) |
| Notifications | SNS → SQS fan-out → Pushover Lambda + Slack Lambda |
| Scheduling | EventBridge Scheduler (America/New_York timezone) |
| Infrastructure | AWS CDK v2 (TypeScript) |
| CI/CD | AWS Amplify — `main` → prod, `dev` → dev |

### CDK Stacks

| Stack | Purpose |
|---|---|
| `Briefings-Hosting-{env}` | S3 + CloudFront + ACM + Route53 |
| `Briefings-Generator-{env}` | Lambda + EventBridge schedules + SNS/SQS fan-out |
| `Briefings-CI` | Amplify CI/CD app (prod only) |

### URLs

| Environment | URL |
|---|---|
| Prod | https://briefings.stevenowicki.com |
| Dev | https://dev.briefings.stevenowicki.com |

### S3 structure

```
/index.html
/manifest.json
/2026/04/01-0800.html     ← Morning
/2026/04/01-1730.html     ← Evening
/2026/04/01-2300.html     ← Late Night
...
```

---

## Briefing Schedule

Defined in `infrastructure/config/briefing-schedules.ts`. All times are America/New_York.

| Briefing | Emoji | Schedule | S3 path |
|---|---|---|---|
| Morning | ☀️ | 8:00am ET | `/YYYY/MM/DD-0800.html` |
| Evening | 🌆 | 5:30pm ET | `/YYYY/MM/DD-1730.html` |
| Late Night | 🌙 | 11:00pm ET | `/YYYY/MM/DD-2300.html` |

Schedules are enabled only in prod. Dev Lambda can be invoked manually for testing.

---

## Configuration Reference

This section documents everywhere you might need to make a configuration change.

### SSM Parameters

All secrets are stored in AWS SSM Parameter Store (us-east-1). Fetched at Lambda runtime — no redeploy needed after updating a value. Cached in memory for the lifetime of a warm container (usually not an issue since briefings run 3×/day).

| SSM Path | Type | Purpose | How to update |
|---|---|---|---|
| `/briefings/anthropic-api-key` | SecureString | Claude API key for briefing generation | `aws ssm put-parameter --name /briefings/anthropic-api-key --value "..." --type SecureString --overwrite` |
| `/briefings/pushover-api-token` | SecureString | Pushover application token | Same pattern |
| `/briefings/pushover-user-key` | SecureString | Pushover user/group key | Same pattern |
| `/briefings/slack-webhook-url` | SecureString | Slack Incoming Webhook URL | Same pattern — change this to redirect briefing posts to a different channel |
| `/briefings/github-oauth-token` | String | GitHub token for Amplify CI/CD | Same pattern (note: must be `String`, not `SecureString`) |

### Briefing Schedules

**File:** `infrastructure/config/briefing-schedules.ts`

Add, remove, or reschedule briefing runs here. Each entry creates one EventBridge Scheduler rule. After editing, push to `main` — Amplify CI/CD redeploys CDK automatically.

### Weather Location

**File:** `lambdas/briefing-generator/lib/weather.ts`

Weather is fetched from wttr.in using **coordinates** (not zip code — wttr.in misresolves US zip codes to international locations). The current coordinates are `40.7282,-73.9842` (StuyTown / Peter Cooper Village center).

To change the location, update the coordinates in `fetchWeather()`:
```typescript
const url = `https://wttr.in/40.7282,-73.9842?format=j1`;
```

### RSS Feed Sources

**File:** `lambdas/briefing-generator/lib/feeds.ts`

Edit the `FEED_GROUPS` array to add, remove, or swap sources. Each entry has:
- `category`: `'top'` | `'nyc'` | `'arts'`
- `name`: display name (shown in logs)
- `url`: RSS or Atom feed URL

Each feed fetch is independent — a single feed failure never aborts the run.

### Claude Model

**File:** `lambdas/briefing-generator/index.ts`

```typescript
const CLAUDE_MODEL = 'claude-opus-4-5';
```

Change this constant to switch models. Requires redeploy.

### Briefing Content & Tone

**File:** `lambdas/briefing-generator/lib/prompt.ts`

- `SYSTEM_PROMPT` — editorial instructions: audience, writing style, section priorities, arts threshold
- `HTML_TEMPLATE` — the CSS and HTML structure every briefing uses
- `buildUserPrompt()` — assembles the live data into the prompt sent to Claude

See `docs/briefing-generation.md` for the human-readable version of these instructions.

### Notification Message Format

- **Pushover:** `lambdas/briefing-pushover/index.ts` — title, message, sound, priority
- **Slack:** `lambdas/briefing-slack/index.ts` — Block Kit layout, `@channel` mention

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

### Manually trigger a briefing (for testing)

```bash
# Morning
aws lambda invoke \
  --function-name briefings-generator-prod \
  --invocation-type Event \
  --payload '{"briefingName":"morning","label":"Morning","time":"08:00","emoji":"☀️"}' \
  --cli-binary-format raw-in-base64-out \
  --profile stevenowicki \
  /tmp/out.json

# Evening
aws lambda invoke \
  --function-name briefings-generator-prod \
  --invocation-type Event \
  --payload '{"briefingName":"evening","label":"Evening","time":"17:30","emoji":"🌆"}' \
  --cli-binary-format raw-in-base64-out \
  --profile stevenowicki \
  /tmp/out.json

# Late Night
aws lambda invoke \
  --function-name briefings-generator-prod \
  --invocation-type Event \
  --payload '{"briefingName":"late-night","label":"Late Night","time":"23:00","emoji":"🌙"}' \
  --cli-binary-format raw-in-base64-out \
  --profile stevenowicki \
  /tmp/out.json
```

Use `--invocation-type Event` (async) — the Lambda takes ~90s and the CLI will time out on a synchronous call. Check CloudWatch logs after.

### Reset the manifest (e.g. after a test run)

```bash
# Empty
aws s3 cp - s3://sdn-briefings-prod/manifest.json \
  --content-type application/json \
  --cache-control "no-cache, no-store, must-revalidate" \
  --profile stevenowicki <<< '{"briefings":[]}'

# Invalidate CloudFront
aws cloudfront create-invalidation \
  --distribution-id E3FSTVEBX5WX69 \
  --paths "/manifest.json" \
  --profile stevenowicki
```

### Update index.html

```bash
aws s3 cp src/index.html s3://sdn-briefings-prod/index.html \
  --content-type text/html \
  --cache-control "no-cache, no-store, must-revalidate" \
  --profile stevenowicki

aws cloudfront create-invalidation \
  --distribution-id E3FSTVEBX5WX69 \
  --paths "/index.html" \
  --profile stevenowicki
```

---

## Event Bus

After each successful briefing, the generator publishes to SNS topic `briefings-generated-{env}`.

**Current subscribers:**
- Pushover → push notification to Steve's iPhone
- Slack → Block Kit message posted to `#briefings` with `@channel` mention

**Adding a new subscriber:** add an SQS queue + SNS subscription + Lambda in `BriefingsGeneratorStack`. No changes to the generator Lambda required. See `docs/briefing-generation.md` for the SNS payload schema.

---

## manifest.json schema

```json
{
  "briefings": [
    {
      "url": "/2026/04/01-2300.html",
      "date": "2026-04-01",
      "label": "Late Night",
      "time": "23:00",
      "isoTimestamp": "2026-04-01T23:00:00-04:00",
      "summary": "2-3 sentence summary of top stories."
    }
  ]
}
```

Valid `label` values: `"Morning"` | `"Evening"` | `"Late Night"`

---

## CI/CD

Amplify watches `main` and `dev` branches:

- Push to `main` → deploys all prod stacks + uploads `index.html` + invalidates CloudFront
- Push to `dev` → deploys all dev stacks + uploads `index.html` + invalidates CloudFront

The `Briefings-CI` Amplify app is itself managed by CDK as part of the prod stack.

---

## Roadmap

- **Public push notifications** — Web Push (PWA) is the right architecture for offering opt-in mobile alerts to public readers. Requires: service worker in `index.html`, VAPID key pair, API Gateway + Lambda for subscription storage (DynamoDB), push delivery Lambda. Deferred — meaningful scope, no urgent need.
