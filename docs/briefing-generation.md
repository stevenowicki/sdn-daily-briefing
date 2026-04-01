# Briefing Generation

This document is the authoritative reference for briefing content, tone, data sources, and editorial standards. It mirrors what is encoded in `lambdas/briefing-generator/lib/prompt.ts`.

To change briefing content or tone: edit `lambdas/briefing-generator/lib/prompt.ts`, commit, and push to `main`. Amplify CI/CD redeploys the Lambda automatically.

---

## Schedule

Three briefings per day. All times America/New_York. Defined in `infrastructure/config/briefing-schedules.ts`.

| Briefing | Emoji | Schedule | S3 path |
|---|---|---|---|
| Morning ☀️ | ☀️ | 8:00am ET | `/YYYY/MM/DD-0800.html` |
| Evening 🌆 | 🌆 | 5:30pm ET | `/YYYY/MM/DD-1730.html` |
| Late Night 🌙 | 🌙 | 11:00pm ET | `/YYYY/MM/DD-2300.html` |

Each briefing is a self-contained HTML page. Claude claude-opus-4-5 generates the full HTML from live data (RSS feeds + weather + markets).

---

## Audience

Steve lives in **StuyTown / Peter Cooper Village**, Manhattan, NYC (coordinates: 40.7282, -73.9842).

- Politically engaged, well-informed, progressive
- Interested in NYC local politics and city governance
- Enjoys Broadway, off-Broadway, opera, classical music, gallery openings
- Reads The Atlantic, NYT, WaPo — expects prose to match that quality level
- Does NOT want: clickbait, vague filler, AI-sounding disclaimers, obvious information

---

## Writing Style

- **Direct and specific.** No weasel words ("appears to", "may have"). State facts.
- **Lead with the most important information.** Don't bury the lede.
- **Use numbers.** "$12B", "1,200 killed", "down 2.4%", not vague quantifiers.
- **Summaries are 2–3 tight sentences.** No padding.
- **Headlines:** informative, not sensational. Rewrite vague originals.
- **Occasional dry wit is fine.** Avoid forced cheerfulness.
- **Register:** matches a quality daily newspaper (NYT, WaPo, The Atlantic).

---

## Sections

### 1. Header
- Title: "Steve's [Morning | Evening | Late Night] Briefing"
- Emoji: ☀️ for Morning, 🌆 for Evening, 🌙 for Late Night
- Date: full date string, e.g. "Tuesday, April 1, 2026"
- Navigation back to homepage: 📰 ← All Briefings (links to https://briefings.stevenowicki.com)

### 2. Weather
**Source:** wttr.in via coordinates `40.7282,-73.9842` (StuyTown/Peter Cooper Village)

> **Important:** wttr.in misresolves US zip codes internationally (10010 → Taiwan). Always use lat/lon. Code is in `lambdas/briefing-generator/lib/weather.ts`.

Include:
- Current temperature + feels like
- Today's high and low
- Wind speed and direction
- Precipitation chance with timing (e.g., "Rain likely after 3pm")
- Umbrella advisory if rain > 30% chance
- Tomorrow preview if meaningfully different

Tone: practical and specific. "Light rain after 2pm; umbrella worth having" not "There may be precipitation."

### 3. Top News Headlines
**Sources:** CNN, NPR, NYT, BBC World, PBS NewsHour, ABC News, CBS News, Washington Post (World + National)

**Selection:** 4–6 stories. Major stories of global significance:
- US foreign policy and military action
- Geopolitical developments
- Major domestic policy (legislation, Supreme Court, elections)
- Significant economic news
- Major disasters or humanitarian crises
- Culturally significant events of national scope

**Skip:** pure celebrity gossip, minor local crime, routine sports scores.

### 4. US News
**Sources:** Same as Top News (different angle — domestic focus)

**Selection:** 3–5 stories NOT already covered in Top News:
- Federal government, Congress, White House
- Economic data (jobs, inflation, Fed)
- Legal/Supreme Court
- Major state-level news with national implications
- Immigration, healthcare, infrastructure policy

### 5. NYC News
**Sources:** Gothamist, The City, NYT NY Region, NBC New York, NY Post, Brooklyn Paper

**Selection:** 4–6 stories most relevant to someone living in StuyTown:
- MTA/transit: service changes, new lines, fare policy, safety
- Local politics: City Council, Mayor, Borough Presidents
- Development and housing
- Crime patterns (not individual incidents unless very significant)
- Quality of life: parks, streets, noise, sanitation
- Borough-specific news — all 5 boroughs covered, not just Manhattan
- NYPD, FDNY, school system

**Prioritize:** The City and Gothamist for investigative/original reporting; NBC/Post for breaking news.

### 6. Feel-Good News
**Sources:** Drawn from all feeds above; Claude selects the most uplifting

**Selection:** 2–3 genuinely uplifting stories:
- Scientific breakthroughs or medical advances
- Community wins and local heroes
- Surprising acts of human kindness or generosity
- Conservation wins, environmental good news
- Underdog stories with real stakes

**Skip:** trivial ("puppy rescued"), manufactured feel-good, pure fluff.

### 7. Arts *(conditional — OMIT if nothing meets the bar)*
**Sources:** BroadwayWorld, NYT Arts, NYT Theater, TheaterMania, ArtsJournal, Hyperallergic, Slippedisc, Variety Legit, Hollywood Reporter, Deadline

**Include:**
- Broadway and off-Broadway: openings, closings, major casting announcements, Tony buzz
- Opera: Met Opera season news, major casting, significant productions at Lincoln Center or Carnegie Hall
- Classical music: major conductors, Carnegie Hall highlights, significant recordings
- Gallery openings: major museum shows at MoMA, the Met, the Whitney, Guggenheim, etc.
- Cabaret, immersive theater, notable experimental performance in NYC
- Nationally/internationally significant: major films (Oscar season, landmark releases, festival winners), prestigious literary prizes (Pulitzer, Booker, National Book Award)
- TV only if truly significant: final episode of a landmark show, major Emmy contender, etc.

**Do NOT include:**
- Routine rock/pop/hip-hop concerts or tour announcements
- Streaming service announcements without substance
- Minor casting changes
- Reality TV

**Threshold:** If you can't find at least 1 item that's genuinely worth Steve's attention, **omit the Arts section entirely.** Do not pad it.

### 8. Markets
**Sources:** Yahoo Finance (unofficial API, no key required)

**Always include:**
- S&P 500: price, % change from previous close, market state (pre/regular/post/closed)
- Brent Crude: price per barrel, % change

**Include if noteworthy:**
- Nasdaq: if there's a significant tech-driven story
- Bitcoin: if notable move (>5% in a day)

**Context:** Add 1-2 sentences of context for each significant market move. Why did the S&P fall? What's driving oil? Connect to the news stories above when relevant.

### 9. Footer / Kicker
A single closing line. Rules:
- Warm but not saccharine
- Matches the emotional register of the day's news (understated if heavy news)
- Reference weather, season, or neighborhood when natural
- Occasional references to StuyTown, the Oval, Tompkins Square, the East Village, or the waterfront
- Never: forced optimism, AI clichés, "Have a great day!"

---

## Data Sources Reference

### Active RSS feeds

| Category | Source | Feed URL |
|---|---|---|
| Top/World | CNN | `http://rss.cnn.com/rss/cnn_topstories.rss` |
| Top/World | NPR | `https://feeds.npr.org/1001/rss.xml` |
| Top/World | New York Times | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` |
| Top/World | BBC World | `http://feeds.bbci.co.uk/news/world/rss.xml` |
| Top/World | PBS NewsHour | `https://www.pbs.org/newshour/feeds/rss/headlines` |
| Top/World | ABC News | `https://feeds.abcnews.com/abcnews/topstories` |
| Top/World | CBS News | `https://www.cbsnews.com/latest/rss/main` |
| Top/World | Washington Post | `https://feeds.washingtonpost.com/rss/world` |
| Top/World | Washington Post US | `https://feeds.washingtonpost.com/rss/national` |
| NYC | Gothamist | `https://gothamist.com/feed` |
| NYC | The City | `https://www.thecity.nyc/feed` |
| NYC | NBC New York | `https://www.nbcnewyork.com/feed/` |
| NYC | NY Post | `https://nypost.com/feed/` |
| NYC | NYT NY Region | `https://rss.nytimes.com/services/xml/rss/nyt/NYRegion.xml` |
| NYC | Brooklyn Paper | `https://www.brooklynpaper.com/feed/` |
| Arts | BroadwayWorld | `https://www.broadwayworld.com/rss.cfm` |
| Arts | NYT Arts | `https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml` |
| Arts | NYT Theater | `https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml` |
| Arts | TheaterMania | `https://www.theatermania.com/rss/` |
| Arts | ArtsJournal | `https://www.artsjournal.com/feed` |
| Arts | Hyperallergic | `https://hyperallergic.com/feed/` |
| Arts | Slippedisc | `https://slippedisc.com/feed/` |
| Arts | Variety Legit | `https://variety.com/v/legit/feed/` |
| Arts | Deadline | `https://deadline.com/feed/` |
| Arts | Hollywood Reporter | `https://www.hollywoodreporter.com/feed/` |

### Sources without RSS (covered by others)

| Source | Reason | Coverage via |
|---|---|---|
| AP News | Discontinued public RSS | CNN, NPR, NYT, PBS syndicate AP content |
| City & State NY | No RSS feed | The City + Gothamist cover NYC political beat |
| Time Out NYC | Intermittent RSS | Other arts feeds cover NYC events |

---

## Event Bus & Notifications

After each successful briefing, the generator Lambda publishes to SNS topic `briefings-generated-{env}`.

### Current subscribers

| Consumer | Queue | What it does |
|---|---|---|
| Pushover | `briefings-pushover-queue-{env}` | Sends push notification to Steve's iPhone |
| Slack | `briefings-slack-queue-{env}` | Posts Block Kit message to `#briefings` with `@channel` |

Both subscribers use `rawMessageDelivery: true` — the SQS message body is the SNS payload directly.

### Adding a new subscriber

1. Add a new SQS queue + DLQ in `BriefingsGeneratorStack`
2. Subscribe the queue to `briefingsTopic` with `rawMessageDelivery: true`
3. Add a new `NodejsFunction` Lambda consuming that queue
4. Grant SSM read permission for any credentials the Lambda needs
5. No changes to the generator Lambda required

### SNS payload schema

```json
{
  "briefingId": "2026-04-01-0800",
  "url": "/2026/04/01-0800.html",
  "fullUrl": "https://briefings.stevenowicki.com/2026/04/01-0800.html",
  "date": "2026-04-01",
  "label": "Morning",
  "time": "08:00",
  "isoTimestamp": "2026-04-01T08:00:00-04:00",
  "summary": "2-3 sentence summary of top stories.",
  "emoji": "☀️"
}
```

Valid `label` values: `"Morning"` | `"Evening"` | `"Late Night"`
