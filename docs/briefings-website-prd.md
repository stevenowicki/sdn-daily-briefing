# PRD: Steve's News Briefings
**briefings.stevenowicki.com**

---

## Overview

A personal news briefing website that hosts daily and evening HTML briefings, accessible at a memorable URL and optimized for quick reading on a phone. The site replaces the current workflow (saving HTML to iCloud Drive / drafting Gmail) with a durable, always-available archive that integrates cleanly with the existing Pushover notification step.

---

## Goals

- Every briefing run produces a permanent, shareable URL
- Pushover notification taps directly to the specific briefing that just ran
- Index page acts as a news-style home screen: most recent briefing featured prominently, full archive navigable by date
- No public S3 bucket; all content served through CloudFront
- Zero manual steps — uploading and index regeneration happen automatically as part of each briefing run

---

## Non-Goals

- Authentication / login (these are personal briefings with no sensitive content)
- Comments, sharing, or social features
- Server-side rendering or a backend web framework
- Push notifications beyond Pushover (already handled elsewhere)

---

## Architecture

### AWS Infrastructure (CDK — TypeScript)

**S3 Bucket**
- Private bucket; no public access policy
- Versioning enabled
- Logical structure:
  ```
  /index.html
  /manifest.json
  /2026/04/01-0800.html
  /2026/04/01-1730.html
  /2026/04/02-0800.html
  ...
  ```

**CloudFront Distribution**
- Origin: the S3 bucket via Origin Access Control (OAC) — no public bucket policy needed
- Default root object: `index.html`
- Custom domain: `briefings.stevenowicki.com`
- ACM certificate: provisioned in `us-east-1` (required for CloudFront)
- Cache behavior:
  - `index.html` and `manifest.json`: short TTL (60s), or invalidate on each upload
  - Briefing HTML files (`/YYYY/*`): long TTL (immutable; filenames include the timestamp)
- Custom 404 response: redirect to `index.html` so the SPA handles routing gracefully

**DNS**
- Route 53 (or CNAME if DNS is hosted elsewhere): `briefings.stevenowicki.com` → CloudFront distribution domain

**No Lambda required** — the index page is a static SPA that fetches `manifest.json` at load time. Index updates are handled by the briefing task updating `manifest.json` and invalidating the CloudFront cache for that file.

### CDK Stack Structure (suggested)

```
lib/
  briefings-stack.ts     # S3 bucket + CloudFront + OAC + certificate + DNS
bin/
  briefings.ts           # CDK app entry point
```

---

## URL Schema

| Content | URL |
|---|---|
| Index (home) | `https://briefings.stevenowicki.com/` |
| Morning briefing | `https://briefings.stevenowicki.com/2026/04/01-0800.html` |
| Evening briefing | `https://briefings.stevenowicki.com/2026/04/01-1730.html` |
| Manifest (machine-readable) | `https://briefings.stevenowicki.com/manifest.json` |

**File naming convention:** `DD-HHMM.html` where time is in 24h ET. Morning runs at 08:07 → `01-0800.html`. Evening runs at 17:30 → `01-1730.html`. (Round to the nearest clean time for readability, e.g. always name as `0800` regardless of jitter.)

---

## manifest.json Schema

`manifest.json` is the source of truth for the index page. The briefing task updates it on each run by prepending a new entry. The index page fetches this at load time.

```json
{
  "briefings": [
    {
      "url": "/2026/04/01-1730.html",
      "date": "2026-04-01",
      "label": "Evening",
      "time": "17:30",
      "isoTimestamp": "2026-04-01T17:30:00-04:00",
      "summary": "Iran War Day 31: Trump eyes Kharg Island seizure, sending Brent crude above $116. S&P falls 0.39% as oil-driven sell-off continues. 8 million march in 'No Kings' protests across 50 states — possibly the largest single-day protest in US history."
    },
    {
      "url": "/2026/04/01-0800.html",
      "date": "2026-04-01",
      "label": "Morning",
      "time": "08:00",
      "isoTimestamp": "2026-04-01T08:00:00-04:00",
      "summary": "..."
    }
  ]
}
```

The `summary` field is 2–3 sentences capturing the most important stories from that run. The briefing task (Claude) generates this summary at the time of upload — it's already aware of the top stories since it just compiled the briefing.

---

## Briefing Task Changes

The morning and evening briefing tasks need the following additions after generating the HTML:

1. **Upload briefing HTML to S3**
   ```bash
   aws s3 cp briefing.html s3://<bucket>/2026/04/01-0800.html \
     --content-type text/html \
     --cache-control "max-age=31536000, immutable"
   ```

2. **Download current manifest.json from S3, prepend new entry, re-upload**
   ```bash
   aws s3 cp s3://<bucket>/manifest.json manifest.json
   # (prepend new entry to briefings array)
   aws s3 cp manifest.json s3://<bucket>/manifest.json \
     --content-type application/json \
     --cache-control "max-age=60"
   ```

3. **Invalidate CloudFront cache for manifest.json and index.html**
   ```bash
   aws cloudfront create-invalidation \
     --distribution-id <ID> \
     --paths "/manifest.json" "/index.html"
   ```

4. **Send Pushover notification** with the full briefing URL:
   ```
   url: https://briefings.stevenowicki.com/2026/04/01-0800.html
   url_title: Open Morning Briefing
   message: <2-3 sentence summary>
   title: ☀️ Morning Briefing — April 1
   ```

The AWS CLI and CloudFront distribution ID should be available in the environment where the briefing tasks run.

---

## Index Page (`index.html`)

### Behavior

- Static SPA; fetches `manifest.json` from the same origin at load time
- Groups briefings by date, then by month/year for the archive
- Most recent briefing is featured at the top with its full summary visible
- Older briefings show label, date/time, and summary in a condensed card format
- Clicking any briefing navigates to its full HTML page

### Layout

```
┌─────────────────────────────────────────┐
│  BRIEFINGS.STEVENOWICKI.COM             │
│  [Year nav: 2026 | 2025 | ...]          │
├─────────────────────────────────────────┤
│  LATEST                                 │
│  ┌───────────────────────────────────┐  │
│  │ Evening Briefing · April 1, 2026  │  │
│  │                                   │  │
│  │ Iran War Day 31: Trump eyes       │  │
│  │ Kharg Island seizure... [summary] │  │
│  │                                   │  │
│  │             [Read Full Briefing →] │  │
│  └───────────────────────────────────┘  │
├─────────────────────────────────────────┤
│  APRIL 2026                             │
│  ┌──────────────┐ ┌──────────────────┐  │
│  │ Morning      │ │ Evening          │  │
│  │ Apr 1 · 8am  │ │ Apr 1 · 5:30pm  │  │
│  │ [summary...] │ │ [summary...]     │  │
│  └──────────────┘ └──────────────────┘  │
│  ┌──────────────┐                       │
│  │ Morning      │                       │
│  │ Mar 31 · 8am │                       │
│  │ [summary...] │                       │
│  └──────────────┘                       │
├─────────────────────────────────────────┤
│  MARCH 2026  ▼ (collapsible)           │
│  ...                                    │
└─────────────────────────────────────────┘
```

On mobile, the two-column card grid collapses to a single column. The featured latest briefing remains full-width.

### Design Requirements

- **Aesthetic:** Modern news site — think The Atlantic or BBC News. Serif or high-quality sans-serif headlines, clean whitespace, strong typographic hierarchy.
- **Color scheme:** Light background with a dark navy or charcoal masthead. Accent color for Morning (amber/gold) vs. Evening (indigo/slate) briefings to distinguish them visually.
- **Typography:**
  - Masthead: bold, uppercase, tracked
  - Headlines/dates: strong weight
  - Summary text: comfortable reading size, generous line height
- **Mobile-first:** All layouts should be designed for 390px width first, then enhanced for larger screens.
- **Dark mode:** Support `prefers-color-scheme: dark` — invert the palette tastefully.
- **No external dependencies / CDN required:** The index page should be fully self-contained (inline CSS, vanilla JS). This avoids latency and keeps the page fast on mobile.
- **Loading state:** Show a skeleton or simple spinner while `manifest.json` is fetching. Handle fetch errors gracefully (show a message rather than a blank screen).
- **Accessibility:** Semantic HTML (`<article>`, `<nav>`, `<main>`, `<time>`), sufficient color contrast, keyboard-navigable.
- **Icon:** - There should be an icon in the upper-left of all pages as well as a favicon that represents the idea of a news briefing. That icon on the individual briefing pages should return us to the homepage.

### Year Navigation

- At the top of the page (or in a sticky nav), show tabs or pills for each year present in `manifest.json`
- Selecting a year scrolls to or filters to that year's briefings
- Default view: current year expanded, previous years collapsed

---

## Individual Briefing Pages

The HTML files for individual briefings are generated by the briefing task and do **not** need modification. They are already well-formatted, mobile-friendly, and self-contained. Upload them to S3 as-is.

No changes needed to the briefing HTML format.

The individual briefings pages should have a navigation link back to the index page.

Be sure to refer to the briefing task for all of the details on what should be in the individual briefing page. 

Let's add an arts section to the sections we already have in the briefing. This should focus on truly noteworthy arts events, preferring Broadway, off-Broadway, Opera, and other live performance events over, say, rock concerts, which I don't normally attend. This can also include notable art gallery activites, weird and quirky things, cabaret performances, and other arts events as you see fit, but only if they're really worth a look. If there is nothing particularly notable for any given briefing, please just skip the arts section rather than surfacing less notable events just to fill the section.

---

## Implementation Notes for Claude Code

- **CDK version:** Use CDK v2 (`aws-cdk-lib`)
- **Certificate:** Must be in `us-east-1` for CloudFront, even if the stack is deployed in another region. Use a cross-region reference or a separate nested stack.
- **OAC vs OAI:** Use Origin Access Control (OAC), not the older Origin Access Identity (OAI) — OAC is the current recommended pattern.
- **Cache invalidation:** Wildcard invalidations (`/*`) are free for the first 1,000 paths/month. For this use case, targeted invalidations of `/manifest.json` and `/index.html` are sufficient and preferred. In the unlikely event that a specific timed briefing (e.g., 5:30 pm) needs to be re-run at the request of the user, for example if there were bugs that need to be addressed, the direct path to the html file should also be invalidated.
- **`manifest.json` update script:** A small Node.js or Python script that downloads the current manifest, prepends the new entry, and re-uploads. Keep it simple — no database, no Lambda.
- **Environment variables needed by briefing tasks:** `BRIEFINGS_BUCKET_NAME`, `BRIEFINGS_CLOUDFRONT_DISTRIBUTION_ID`. These can be output by the CDK stack and stored in the environment.
- **AWS credentials:** The briefing tasks already need to be able to call `aws s3 cp` and `aws cloudfront create-invalidation`. Ensure the IAM role/user has `s3:PutObject`, `s3:GetObject` on the bucket and `cloudfront:CreateInvalidation` on the distribution.

---

## Acceptance Criteria

- [ ] CDK stack deploys successfully with `cdk deploy`
- [ ] `https://briefings.stevenowicki.com/` serves the index page over HTTPS
- [ ] Uploading a new HTML file + updating `manifest.json` results in the new briefing appearing on the index within ~60 seconds (after CloudFront invalidation)
- [ ] Pushover notification URL opens the correct briefing directly on iPhone
- [ ] Index page is readable and usable on iPhone (390px) without horizontal scrolling
- [ ] Dark mode renders correctly
- [ ] Navigating directly to a briefing URL (e.g. `https://briefings.stevenowicki.com/2026/04/01-0800.html`) works without a 403 or 404
- [ ] A fetch error on `manifest.json` shows a graceful error state, not a blank page

---

---

## Backlog

Ideas and explorations deferred from active development. Not prioritized or scheduled.

### Affordable SSE for real-time updates

**Context:** The homepage currently polls `manifest.json` every 60 seconds using a conditional GET (`If-None-Match`). CloudFront returns `304 Not Modified` from cache for 99.9% of polls — essentially free. New briefings appear within 60 seconds of publication, which is imperceptible for a 3×/day schedule.

**Why we didn't use SSE now:** True Server-Sent Events require one persistent server-side connection per connected browser tab. On Lambda, "keeping a connection open" costs the same as "running compute" — ~$0.0035/user/14-min cycle, or ~$1,080/month at 100 concurrent users with tabs open 24/7. That's not the right tool for a signal that fires 3 times a day.

**The interesting problem:** SSE at scale requires decoupling connection management from compute. The approaches worth understanding:

- **AWS IoT Core + MQTT over WebSocket** — the AWS-native answer. IoT Core manages millions of persistent connections at $0.08/million device-minutes. The Lambda publishes to an IoT topic when a briefing is ready; connected browsers receive it immediately. Requires Cognito Identity Pools to issue temporary browser credentials, and MQTT.js in the browser (which would violate the current no-external-deps rule). Scales to billions of connections.

- **ECS Fargate + Redis Pub/Sub** — persistent SSE servers behind an ALB. Each server holds N open connections cheaply (connections are file descriptors, not threads). When a briefing is published, Lambda publishes to a Redis channel; all SSE servers broadcast to their connected clients. Horizontal scaling via Auto Scaling. More ops overhead than Lambda but the right model for SSE.

- **Managed pub/sub (Pusher, Ably, etc.)** — delegates the connection layer entirely. Simple SDK, real-time delivery, pay-per-message pricing. Adds an external dependency and vendor relationship.

**What to explore:** Build a small proof-of-concept using IoT Core to understand the credential flow and MQTT-over-WebSocket in the browser. The briefings app isn't the right vehicle (wrong scale, no-external-deps rule), but a standalone experiment would be a good learning exercise.

### Public push notifications

**Context:** Briefing-generated events currently fan out to Pushover (personal iPhone notification) and Slack (#briefings). There's no mechanism for other users of the site to opt in to push notifications.

**Options evaluated (all deferred):**
- **Web Push API / PWA** — browser-native, no app required, but requires a service worker and significant scope expansion to make the site a PWA.
- **ntfy.sh** — self-hostable push notification service, but requires users to install an obscure third-party app.
- **Pushover public channel** — simplest option, but requires every subscriber to install and pay for Pushover.

**What to explore:** Revisit when/if the site has an audience beyond a single user. Web Push is the cleanest long-term answer; the service worker complexity is the main deterrent.

---

*Generated April 1, 2026 · briefings.stevenowicki.com project*
