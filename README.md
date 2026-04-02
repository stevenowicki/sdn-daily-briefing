# sdn-daily-briefing

Personal news briefing website — **briefings.stevenowicki.com**

Three scheduled briefings per day (morning, evening, late night), plus on-demand breaking news interrupts, are generated automatically by AWS Lambda, uploaded to a private S3 bucket, and served through CloudFront. The index page is a self-contained SPA that acts as a permanent archive.

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
| Breaking news | EventBridge cron every 30 min → Lambda source-count check |
| Infrastructure | AWS CDK v2 (TypeScript) |
| CI/CD | AWS Amplify — `main` → prod, `dev` → dev |

### CDK Stacks

| Stack | Purpose |
|---|---|
| `Briefings-Hosting-{env}` | S3 + CloudFront + ACM + Route53 |
| `Briefings-Generator-{env}` | Lambda + EventBridge schedules + breaking news cron + SNS/SQS fan-out |
| `Briefings-Monitoring` | CloudWatch dashboards and alarms (prod only) |
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
/2026/04/01-1423.html     ← Breaking (time = when triggered)
/_state/
  breaking-checker.json   ← Runtime state: cooldown for breaking news re-trigger
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
| Breaking | 🚨 | Triggered by 7+ sources on same story | `/YYYY/MM/DD-HHMM.html` |

Scheduled briefings are enabled only in prod. Breaking news checks run every 30 minutes in prod, never within 90 minutes of a scheduled briefing. The dev Lambda can be invoked manually for testing.

---

## Configuration Reference

This section documents everywhere you might need to make a configuration change.

### SSM Parameters

All secrets are stored in AWS SSM Parameter Store (us-east-1). Fetched at Lambda runtime — no redeploy needed after updating a value. Cached in memory for the lifetime of a warm container.

**SSM is for secrets and config only.** Mutable runtime state lives in S3 under `_state/`.

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

- `SYSTEM_PROMPT` — editorial instructions: audience, writing style, section priorities, arts threshold, story prominence, two-layer story structure, Situation Room mode, historical parallels, source framing variance, What to Watch
- `HTML_TEMPLATE` — the CSS and HTML structure every briefing uses
- `buildUserPrompt()` — assembles the live data into the prompt sent to Claude

See `docs/briefing-generation.md` for the human-readable version of these instructions.

### Breaking News Tuning

**File:** `lambdas/briefing-generator/index.ts`

```typescript
const BREAKING_THRESHOLD    = 7;   // sources required to trigger a breaking briefing
const BREAKING_COOLDOWN_H   = 4;   // hours before the same story can re-trigger
const SITUATION_ROOM_THRESHOLD = 6; // sources required for Situation Room card
```

### Notification Message Format

- **Pushover:** `lambdas/briefing-pushover/index.ts` — title, message, sound, priority. Breaking news uses Pushover emergency priority (bypasses Do Not Disturb, requires acknowledgment).
- **Slack:** `lambdas/briefing-slack/index.ts` — Block Kit layout, `@channel` mention. Breaking news uses red accent color and `<!channel>` mention.

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

Always use `--invocation-type Event` (async) — the Lambda takes ~90s and the CLI will time out on a synchronous call. Check CloudWatch logs after.

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

### Re-running a briefing for a specific past date

Use `dateOverride` to override the date when the clock has ticked past midnight:

```bash
aws lambda invoke \
  --function-name briefings-generator-prod \
  --invocation-type Event \
  --payload '{"briefingName":"late-night","label":"Late Night","time":"23:00","emoji":"🌙","dateOverride":"2026-04-01"}' \
  --cli-binary-format raw-in-base64-out \
  --profile stevenowicki \
  /tmp/out.json
```

When `dateOverride` is set, the S3 key, manifest entry, and briefing header all use the overridden date. The news content is still fetched live (current feeds/weather/markets), so this is most useful for same-night re-runs, not historical reconstruction.

### Manually trigger a breaking news check

```bash
aws lambda invoke \
  --function-name briefings-generator-prod \
  --invocation-type Event \
  --payload '{"action":"check-breaking"}' \
  --cli-binary-format raw-in-base64-out \
  --profile stevenowicki \
  /tmp/out.json
```

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

### Invalidate a specific briefing page

Needed if a briefing is re-run after a bug fix:

```bash
aws cloudfront create-invalidation \
  --distribution-id E3FSTVEBX5WX69 \
  --paths "/manifest.json" "/index.html" "/2026/04/01-2300.html" \
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

Valid `label` values: `"Morning"` | `"Evening"` | `"Late Night"` | `"Breaking"`

---

## CI/CD

Amplify watches `main` and `dev` branches:

- Push to `main` → deploys all prod stacks + uploads `index.html` + invalidates CloudFront
- Push to `dev` → deploys all dev stacks + uploads `index.html` + invalidates CloudFront

The `Briefings-CI` Amplify app is itself managed by CDK as part of the prod stack.

**Stacks deployed per branch:**

| Stack | `main` (prod) | `dev` |
|---|---|---|
| `Briefings-Hosting-{env}` | ✓ | ✓ |
| `Briefings-Generator-{env}` | ✓ | ✓ |
| `Briefings-Monitoring` | ✓ | — |
| `Briefings-CI` | ✓ (idempotent) | — |

---

## Roadmap

See `docs/briefings-website-prd.md` for the full backlog. Key deferred items:

- **Migrate state to DynamoDB** — Breaking news cooldown and future stateful features should move from S3 JSON files to DynamoDB (TTL, atomic writes, query capability). Trigger: when a second stateful feature beyond breaking news is added.
- **Story arc tracking** — detect when a story has been covered across multiple consecutive briefings and synthesize an arc ("Day 3 of coverage: ...").
- **Weekly synthesis** — Sunday evening briefing includes a "Week in Review" section with the week's most significant threads.
- **Audio edition (Amazon Polly)** — generate an MP3 version of the briefing summary section; link it from the briefing page as a "Listen" button.
- **Market sparklines** — inline 5-day price chart SVGs for S&P and Brent Crude, generated at briefing time from historical close data.
- **NYC civic action layer** — upcoming City Council votes, community board meetings, permit filings, and public hearings relevant to StuyTown/East Side.
- **Historical "This Day"** — one verified historical event from this date that connects to a current news story.
- **Slow Read** — one long-form piece per briefing: a New Yorker article, Atlantic essay, or similar that repays careful reading.
- **Affordable SSE for real-time updates** — see detailed analysis in `docs/briefings-website-prd.md`.
- **Public push notifications** — Web Push (PWA) is the right architecture for opt-in mobile alerts to public readers.
