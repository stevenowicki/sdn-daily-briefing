# CLAUDE.md — sdn-daily-briefing

Context and conventions for any AI assistant working in this repo.

---

## What this project is

A personal static news briefing website at **briefings.stevenowicki.com**. Three briefings per day (morning, evening, late night) are generated automatically by an AWS Lambda on a schedule, uploaded to a private S3 bucket, and served through CloudFront. The index page (`src/index.html`) is a self-contained SPA that fetches `manifest.json` at load time and renders a permanent archive.

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
| Generator (prod) | `Briefings-Generator-prod` | Lambda + EventBridge schedules + SNS/SQS fan-out (schedules ENABLED) |
| Generator (dev) | `Briefings-Generator-dev` | Same (schedules DISABLED — invoke Lambda manually for testing) |
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

| Path | Type | Content |
|---|---|---|
| `/briefings/anthropic-api-key` | SecureString | Claude API key |
| `/briefings/pushover-api-token` | SecureString | Pushover application token |
| `/briefings/pushover-user-key` | SecureString | Pushover user/group key |
| `/briefings/slack-webhook-url` | SecureString | Slack Incoming Webhook URL (currently `#briefings` channel) |
| `/briefings/github-oauth-token` | **String** | GitHub OAuth token for Amplify CI/CD (must be String, not SecureString) |

---

## Briefing schedule

Defined in `infrastructure/config/briefing-schedules.ts`. All times America/New_York.

| Name | Label | Emoji | Time | S3 key suffix |
|---|---|---|---|---|
| `morning` | Morning | ☀️ | 8:00am | `DD-0800.html` |
| `evening` | Evening | 🌆 | 5:30pm | `DD-1730.html` |
| `late-night` | Late Night | 🌙 | 11:00pm | `DD-2300.html` |

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
| Pushover notification format | `lambdas/briefing-pushover/index.ts` |
| Slack message format | `lambdas/briefing-slack/index.ts` |
| Homepage SPA | `src/index.html` — no build step, deployed as-is |

**Weather location note:** wttr.in misresolves US zip codes to international locations (ZIP 10010 resolves to Taiwan). Always use lat/lon coordinates. Current value: `40.7282,-73.9842` (StuyTown center).

---

## index.html conventions

- **No build step.** The file is deployed as-is to S3. Never add a bundler or external CSS/JS dependency.
- **Fully self-contained.** All CSS is in a `<style>` block; all JS is in a `<script>` block.
- **CSS custom properties** handle theming. Light/dark mode is driven entirely by `prefers-color-scheme: dark`. Never add a manual toggle.
- **Label colors** — each briefing type has its own pill color defined as CSS custom properties: `--morning-*`, `--evening-*`, `--latenight-*`. When adding a new briefing type, add CSS vars in both light and dark `:root` blocks, add `.featured-label.{class}` and `.card-label.{class}` rules, and update `labelClass()` and `labelEmoji()` in the JS.
- **Data flow:** on load, fetch `/manifest.json` → render. No other network requests.
- **Security:** all user-controlled data from manifest.json is escaped with `escHtml()` before being inserted into the DOM. Never use `innerHTML` with unescaped data.

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

On push, Amplify runs `amplify.yml` which: deploys CDK → uploads `index.html` → invalidates CloudFront.

Amplify does **not** host the site. It is purely a CI/CD runner.

---

## Things to avoid

- Never make `src/index.html` depend on external resources (fonts, scripts, icons from CDN).
- Never add a `package.json` at the repo root. Only `infrastructure/` and individual `lambdas/*/` directories have their own package.json.
- Never make the S3 bucket public. All access is through CloudFront OAC.
- Never invalidate `/*` — only invalidate specific paths (`/index.html`, `/manifest.json`, or a specific briefing HTML path).
- Never store secrets in code or in git. All secrets live in SSM.
- Never use a zip code with wttr.in — use lat/lon coordinates.
- When invoking the generator Lambda for testing, always use `--invocation-type Event` (async). The Lambda takes ~90 seconds and a synchronous CLI call will time out.
