# CLAUDE.md — sdn-daily-briefing

Context and conventions for any AI assistant working in this repo.

---

## What this project is

A personal static news briefing website at **briefings.stevenowicki.com**. Three scheduled briefings per day (morning, evening, late night) plus on-demand breaking news interrupts are generated automatically by an AWS Lambda, uploaded to a private S3 bucket, and served through CloudFront. The index page (`src/index.html`) is a self-contained SPA that fetches `manifest.json` at load time and renders a permanent archive.

This repo contains:
- `src/index.html` — the entire front-end; fully self-contained (no build step, no external deps)
- `lambdas/briefing-generator/` — Lambda that fetches RSS/weather/markets, calls Claude, uploads HTML, publishes SNS event
- `lambdas/briefing-pushover/` — Lambda that sends Pushover push notification when a briefing is generated
- `lambdas/briefing-slack/` — Lambda that posts a Slack Block Kit message to `#briefings` when a briefing is generated
- `infrastructure/` — CDK v2 TypeScript stacks
- `infrastructure/config/briefing-schedules.ts` — schedule definitions (times, labels, emojis)
- `docs/` — editorial and architecture documentation
- `amplify.yml` — Amplify CI/CD build spec

---

## Infrastructure overview

| Stack | ID | Purpose |
|---|---|---|
| Hosting (prod) | `Briefings-Hosting-prod` | S3 + CloudFront + Route53 + ACM for `briefings.stevenowicki.com` |
| Hosting (dev) | `Briefings-Hosting-dev` | Same for `dev.briefings.stevenowicki.com` |
| Generator (prod) | `Briefings-Generator-prod` | Lambda + EventBridge schedules + breaking news cron + SNS/SQS fan-out (schedules ENABLED) |
| Generator (dev) | `Briefings-Generator-dev` | Same (schedules DISABLED — invoke Lambda manually for testing) |
| Monitoring | `Briefings-Monitoring` | CloudWatch dashboards and alarms (prod only) |
| CI | `Briefings-CI` | Amplify app — CI/CD only, NOT hosting |

All stacks deploy to **us-east-1** (required for CloudFront ACM certs).

CDK context flag: `--context env=prod` or `--context env=dev`

### Key resource names

- Prod S3 bucket: `sdn-briefings-prod`
- Dev S3 bucket: `sdn-briefings-dev`
- Prod CloudFront distribution ID: `E3FSTVEBX5WX69`
- Dev CloudFront distribution ID: `E2F05U73HSO5HH`
- SNS topic (prod): `briefings-generated-prod`
- SNS topic (dev): `briefings-generated-dev`

---

## SSM parameters

All secrets fetched at Lambda runtime (not baked into code or environment). Updating a value in SSM takes effect on the next cold start with no redeploy needed.

**SSM is for config and secrets only.** Do not store mutable runtime state in SSM — use S3 (current) or DynamoDB (future) for that.

| Path | Type | Content |
|---|---|---|
| `/briefings/anthropic-api-key` | SecureString | Claude API key |
| `/briefings/pushover-api-token` | SecureString | Pushover application token |
| `/briefings/pushover-user-key` | SecureString | Pushover user/group key |
| `/briefings/slack-webhook-url` | SecureString | Slack Incoming Webhook URL (currently `#briefings` channel) |
| `/briefings/github-oauth-token` | **String** | GitHub OAuth token for Amplify CI/CD (must be String, not SecureString) |

---

## Runtime state (S3)

Mutable state that persists between Lambda invocations is stored in the briefings S3 bucket under the `_state/` prefix. Not served through CloudFront (no public URL needed).

| S3 Key | Purpose |
|---|---|
| `_state/breaking-checker.json` | Breaking news cooldown: `{ lastStoryHash, lastTriggeredAt }` |

This is a pragmatic choice. The correct long-term answer is DynamoDB (see backlog in `docs/briefings-website-prd.md`).

---

## Briefing schedule

Defined in `infrastructure/config/briefing-schedules.ts`. All times America/New_York.

| Name | Label | Emoji | Time | S3 key suffix |
|---|---|---|---|---|
| `morning` | Morning | ☀️ | 8:00am | `DD-0800.html` |
| `evening` | Evening | 🌆 | 5:30pm | `DD-1730.html` |
| `late-night` | Late Night | 🌙 | 11:00pm | `DD-2300.html` |
| `breaking` | Breaking | 🚨 | current ET time | `DD-HHMM.html` |

Breaking briefings are triggered automatically by the breaking news checker (EventBridge cron every 30 min) when 7+ independent sources cover the same top story. They are never triggered within 90 minutes of a scheduled briefing.

---

## Lambda event types

The generator Lambda accepts two event shapes:

```typescript
// Sent by EventBridge Scheduler for scheduled briefings, or manually
interface ScheduleEvent {
  briefingName: 'morning' | 'evening' | 'late-night' | 'breaking';
  label: 'Morning' | 'Evening' | 'Late Night' | 'Breaking';
  time: string;           // "08:00", "17:30", "23:00", or current ET time for breaking
  emoji: string;
  dateOverride?: string;  // "YYYY-MM-DD" — for re-running a past briefing date
}

// Sent by the EventBridge cron rule every 30 minutes
interface CheckBreakingEvent {
  action: 'check-breaking';
}
```

Handler dispatches on `'action' in event`.

---

## Key configuration touch points

When making changes, these are the most likely files to edit:

| What to change | File |
|---|---|
| Schedule times, add/remove a run | `infrastructure/config/briefing-schedules.ts` |
| Weather location (coordinates) | `lambdas/briefing-generator/lib/weather.ts` — `fetchWeather()` |
| RSS feed sources | `lambdas/briefing-generator/lib/feeds.ts` — `FEED_GROUPS` array |
| Claude model | `lambdas/briefing-generator/index.ts` — `CLAUDE_MODEL` constant |
| Briefing content, tone, priorities | `lambdas/briefing-generator/lib/prompt.ts` — `SYSTEM_PROMPT` |
| Briefing HTML template / CSS | `lambdas/briefing-generator/lib/prompt.ts` — `HTML_TEMPLATE` |
| Breaking news threshold (sources) | `lambdas/briefing-generator/index.ts` — `BREAKING_THRESHOLD` (default: 7) |
| Breaking news cooldown (hours) | `lambdas/briefing-generator/index.ts` — `BREAKING_COOLDOWN_H` (default: 4) |
| Situation Room threshold (sources) | `lambdas/briefing-generator/index.ts` — `SITUATION_ROOM_THRESHOLD` (default: 6) |
| Breaking news state | `lambdas/briefing-generator/index.ts` — `getBreakingState()` / `saveBreakingState()` |
| Pushover notification format | `lambdas/briefing-pushover/index.ts` |
| Slack message format | `lambdas/briefing-slack/index.ts` |
| Homepage SPA | `src/index.html` — no build step, deployed as-is |

**Weather location note:** wttr.in misresolves US zip codes to international locations (ZIP 10010 resolves to Taiwan). Always use lat/lon coordinates. Current value: `40.7282,-73.9842` (StuyTown center).

---

## index.html conventions

- **No build step.** The file is deployed as-is to S3. Never add a bundler or external CSS/JS dependency.
- **Fully self-contained.** All CSS is in a `<style>` block; all JS is in a `<script>` block.
- **CSS custom properties** handle theming. Light/dark mode is driven entirely by `prefers-color-scheme: dark`. Never add a manual toggle.
- **Label colors** — each briefing type has its own pill color defined as CSS custom properties: `--morning-*`, `--evening-*`, `--latenight-*`, `--breaking-*`. When adding a new briefing type, add CSS vars in both light and dark `:root` blocks, add `.featured-label.{class}` and `.card-label.{class}` rules, and update `labelClass()` and `labelEmoji()` in the JS.
- **Data flow:** on load, fetch `/manifest.json` → render. No other network requests.
- **Security:** all user-controlled data from manifest.json is escaped with `escHtml()` before being inserted into the DOM. Never use `innerHTML` with unescaped data.

---

## prompt.ts CSS classes (HTML_TEMPLATE)

Classes used in the individual briefing pages generated by Claude. When modifying `HTML_TEMPLATE`, keep these in sync:

| Class | Purpose |
|---|---|
| `.situation-room` | Red-bordered card wrapping the dominant story in Situation Room mode |
| `.situation-room-header` | "🚨 SITUATION ROOM" label at the top of the card |
| `.situation-room-grid` | Two-column grid: "What We Know" / "What We Don't Know" |
| `.watch-item` | Container for a single "What to Watch" item |
| `.watch-when` | Trigger condition label ("Watch for: ...") |
| `.watch-what` | Consequence/significance explanation |
| `.story-detail` | Collapsible deeper analysis div (hidden by default) |
| `.story-detail-body` | Inner content of expanded story |
| `.story-analysis-block` | Container for historical parallel or source framing note |
| `.story-analysis-label` | "AI Analysis" or "Source Framing" badge |
| `.story-analysis-text` | Analysis prose |
| `.story-analysis-verify` | "Verify:" link for historical claims |
| `.story-expand` | Button that toggles `.story-detail` open/closed |

The JS expand/collapse block near `</body>` handles `.story-expand` clicks.

---

## AWS account

- Account: `617117175946`
- Profile: `stevenowicki`
- Region: `us-east-1`
- Route53 hosted zone: `ZOSJEODV7MORU` (stevenowicki.com)

---

## CI/CD

Amplify app `Briefings-CI` connects to `github.com/stevenowicki/sdn-daily-briefing`.

| Git branch | Environment | URL |
|---|---|---|
| `main` | prod | https://briefings.stevenowicki.com |
| `dev` | dev | https://dev.briefings.stevenowicki.com |

On push, Amplify runs `amplify.yml` which:
1. Deploys `Briefings-Hosting-$DEPLOY_ENV`
2. Deploys `Briefings-Generator-$DEPLOY_ENV`
3. Deploys `Briefings-Monitoring` (prod only)
4. Deploys `Briefings-CI` (prod only, idempotent)
5. Uploads `src/index.html` to S3
6. Invalidates CloudFront for `/index.html`

Amplify does **not** host the site. It is purely a CI/CD runner.

---

## Things to avoid

- Never make `src/index.html` depend on external resources (fonts, scripts, icons from CDN).
- Never add a `package.json` at the repo root. Only `infrastructure/` and individual `lambdas/*/` directories have their own package.json.
- Never make the S3 bucket public. All access is through CloudFront OAC.
- Never invalidate `/*` — only invalidate specific paths (`/index.html`, `/manifest.json`, or a specific briefing HTML path).
- Never store secrets in code or in git. All secrets live in SSM.
- Never store mutable runtime state in SSM — use S3 `_state/` or DynamoDB.
- Never use a zip code with wttr.in — use lat/lon coordinates.
- When invoking the generator Lambda for testing, always use `--invocation-type Event` (async). The Lambda takes ~90 seconds and a synchronous CLI call will time out.
