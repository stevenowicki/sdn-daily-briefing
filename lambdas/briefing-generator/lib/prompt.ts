/**
 * prompt.ts — System prompt and HTML template for briefing generation
 *
 * EDITING INSTRUCTIONS:
 *   This file defines exactly what goes into each briefing. To change the
 *   content, tone, sections, or priorities, edit the SYSTEM_PROMPT and/or
 *   HTML_TEMPLATE constants below, then push to main.
 *
 *   The companion human-readable doc is at docs/briefing-generation.md.
 *
 * MODEL: claude-opus-4-5 (configured in index.ts)
 */

// ---------------------------------------------------------------------------
// System prompt — instructs Claude on briefing content and quality
// ---------------------------------------------------------------------------
export const SYSTEM_PROMPT = `You are generating Steve's personal daily news briefing — a self-contained HTML page he reads on his iPhone every morning and evening.

ABOUT STEVE
- Lives in StuyTown / Peter Cooper Village, Manhattan, NYC (ZIP 10010)
- Politically engaged, well-informed, progressive
- Interested in NYC local politics and city governance
- Enjoys arts: especially Broadway, off-Broadway, opera, classical music, gallery openings
- Reads The Atlantic, NYT, WaPo — expects prose to match that register
- Does NOT want: clickbait, vague filler, obvious things, AI-sounding disclaimers

WRITING STYLE
- Direct, confident, specific. No weasel words ("appears to be", "may have").
- Summaries are 2–3 tight sentences. Lead with the most important fact.
- Headlines are informative, not sensational. Rewrite them if the original is vague.
- Use numbers: "$12B", "1,200 killed", "down 2.4%", not "millions" or "significant amounts".
- Occasional dry wit is fine. Avoid forced cheerfulness.

STORY PROMINENCE — READ THIS FIRST
Each headline is prefixed with a source count: [7 sources: CNN, NPR, NYT, BBC, PBS, ABC, WaPo].
This tells you how many independent news organizations are leading with that story.

- 5+ sources: This is the dominant story of the day. It goes first and gets EXPANDED treatment:
  a full paragraph (4–6 sentences), not the standard 2–3. If it is historically unprecedented
  (first crewed moon landing in 50+ years, major war outbreak, landmark Supreme Court ruling,
  once-in-a-generation event), make that weight explicit in how you write it.
- 3–4 sources: Major story, lead its section, 3–4 sentences.
- 1–2 sources: Standard treatment, 2–3 sentences.

Stories within each section are already sorted by source count. DO NOT reorder them arbitrarily.
A story covered by 8 sources outranks a story covered by 1 source even if the single-source
story seems interesting. Use editorial judgment only to skip genuinely minor stories.

CONTENT PRIORITIES
- Top/World News: Major stories of global significance. US foreign policy, geopolitics, major disasters, significant elections. 4–6 stories. Skip pure celebrity or entertainment unless culturally significant.
- US News: Domestic US stories not covered in Top News. Politics, Supreme Court, economy, federal policy, major cultural events. 3–5 stories.
- NYC News: Anything affecting life in New York City. Transit, local politics, crime patterns, development, quality of life, borough-specific news. Prefer Gothamist, The City, NYT NY Region sources. 4–6 stories.
- Feel-Good: 2–3 genuinely uplifting stories — scientific breakthroughs, community wins, surprising human kindness. Not trivial ("puppy rescued"). Real heart.
- Arts (CONDITIONAL — only include if there is something genuinely worth Steve's attention):
    • Broadway and off-Broadway: openings, closings, major casting news, Tony-related
    • Opera and classical music: Met Opera, Carnegie Hall, Lincoln Center
    • Gallery openings: major NYC museum shows, significant gallery events
    • Nationally significant: major films (Oscar contenders, landmark releases), significant TV events (finale of major show, major premiere), prestigious book prizes
    • Cabaret, immersive theater, and quirky/notable NYC performance events
    • DO NOT include: routine concerts (rock, pop, rap), streaming drops, most TV news, minor tour announcements
    • If nothing rises to the threshold, OMIT THE ARTS SECTION ENTIRELY — do not pad it
- Markets: Always include S&P 500 and Brent Crude. Include Nasdaq and Bitcoin if there is something notable to say about them. Add context (YTD, reasons for move, what to watch).

KICKER (footer)
A single, warm closing line. Reference the season or weather if relevant. Occasionally reference StuyTown, the Oval, or the neighborhood. Matches the emotional temperature of the day's news — understated if the news is heavy.`;

// ---------------------------------------------------------------------------
// HTML template — the CSS/structure Claude fills in
// ---------------------------------------------------------------------------
export const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>{{TITLE}}</title>
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='4' fill='%231a1a2e'/><text x='4' y='24' font-size='22'>📰</text></svg>">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f0;
      color: #1a1a1a;
      padding: 16px;
      max-width: 680px;
      margin: 0 auto;
      font-size: 16px;
      line-height: 1.6;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #0f172a; color: #e2e8f0; }
      .card { background: #1e293b !important; box-shadow: 0 1px 4px rgba(0,0,0,0.3) !important; }
      .card h2 { color: #64748b !important; }
      .story-title { color: #f1f5f9 !important; }
      .story-summary { color: #94a3b8 !important; }
      .story { border-bottom-color: #334155 !important; }
      .story-links a { background: #334155 !important; color: #e2e8f0 !important; }
      .story-links a:hover { background: #475569 !important; }
      .market-label { color: #f1f5f9 !important; }
      .market-row { border-bottom-color: #334155 !important; }
      .market-sub { color: #64748b !important; }
      .weather-main strong { color: #f1f5f9 !important; }
      .umbrella-note { background: #1c1917 !important; }
      header { background: #020617 !important; }
      footer { background: #020617 !important; color: #94a3b8 !important; }
      .home-link { color: #94a3b8 !important; }
      .home-link:hover { color: #f1f5f9 !important; }
    }
    .home-link {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 0.85rem;
      color: #64748b;
      text-decoration: none;
      margin-bottom: 12px;
      padding: 4px 0;
      transition: color 0.15s;
    }
    .home-link:hover { color: #1a1a2e; }
    header {
      background: #1a1a2e;
      color: white;
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      text-align: center;
    }
    header h1 { font-size: 1.3rem; font-weight: 700; letter-spacing: -0.3px; }
    header p { font-size: 0.85rem; color: #aaa; margin-top: 4px; }
    .card {
      background: white;
      border-radius: 12px;
      padding: 18px;
      margin-bottom: 14px;
      box-shadow: 0 1px 4px rgba(0,0,0,0.07);
    }
    .card h2 {
      font-size: 0.8rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: #888;
      margin-bottom: 14px;
    }
    .weather-main { font-size: 1rem; line-height: 1.7; }
    .weather-main strong { color: #1a1a2e; }
    .umbrella-note {
      margin-top: 10px;
      background: #fff8e1;
      border-left: 3px solid #f59e0b;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 0.9rem;
    }
    .story { padding: 12px 0; border-bottom: 1px solid #f0f0f0; }
    .story:last-child { border-bottom: none; padding-bottom: 0; }
    .story:first-child { padding-top: 0; }
    .story-title { font-size: 0.95rem; font-weight: 700; margin-bottom: 5px; color: #1a1a2e; }
    .story-summary { font-size: 0.88rem; color: #444; line-height: 1.6; margin-bottom: 7px; }
    .story-links { display: flex; flex-wrap: wrap; gap: 6px; }
    .story-links a {
      display: inline-block;
      font-size: 0.78rem;
      font-weight: 600;
      color: #1a1a2e;
      background: #f0f0f0;
      border-radius: 20px;
      padding: 3px 10px;
      text-decoration: none;
    }
    .story-links a:hover { background: #e0e0e0; }
    .market-row {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      padding: 10px 0;
      border-bottom: 1px solid #f0f0f0;
    }
    .market-row:last-child { border-bottom: none; padding-bottom: 0; }
    .market-label { font-weight: 700; font-size: 0.95rem; color: #1a1a2e; }
    .market-value { text-align: right; font-size: 0.9rem; }
    .down { color: #e53e3e; font-weight: 700; }
    .up { color: #38a169; font-weight: 700; }
    .flat { color: #718096; font-weight: 700; }
    .market-sub { font-size: 0.8rem; color: #888; margin-top: 2px; }
    footer {
      background: #1a1a2e;
      color: #ddd;
      border-radius: 12px;
      padding: 16px 20px;
      text-align: center;
      font-size: 0.9rem;
      line-height: 1.6;
    }
  </style>
</head>
<body>

  <a class="home-link" href="https://briefings.stevenowicki.com">
    📰 ← All Briefings
  </a>

  <header>
    <h1>{{HEADER_EMOJI}} {{HEADER_TITLE}}</h1>
    <p>{{HEADER_DATE}}</p>
  </header>

  {{CONTENT}}

  <footer>
    {{KICKER}}
  </footer>

</body>
</html>`;

// ---------------------------------------------------------------------------
// User prompt builder — assembles the full prompt from live data
// ---------------------------------------------------------------------------
export interface PromptData {
  label: 'Morning' | 'Evening' | 'Late Night';
  emoji: string;
  dateStr: string;        // "Tuesday, April 1, 2026"
  weather: string;        // Pre-formatted weather summary
  markets: string;        // Pre-formatted market data
  topItems: string;       // Feed headlines for top/world
  nycItems: string;       // Feed headlines for NYC
  artsItems: string;      // Feed headlines for arts
}

export function buildUserPrompt(data: PromptData): string {
  return `Generate Steve's ${data.label} Briefing for ${data.dateStr}.

Use the HTML_TEMPLATE format exactly. Replace the placeholders:
  {{TITLE}}        → "Steve's ${data.label} Briefing — ${data.dateStr}"
  {{HEADER_EMOJI}} → "${data.emoji}"
  {{HEADER_TITLE}} → "Steve's ${data.label} Briefing"
  {{HEADER_DATE}}  → "${data.dateStr}"
  {{CONTENT}}      → All the section cards (weather, news, markets, etc.)
  {{KICKER}}       → The closing footer line

HTML TEMPLATE TO USE:
${HTML_TEMPLATE}

---

WEATHER DATA (use this for the weather card):
${data.weather}

---

MARKET DATA (use this for the markets card):
${data.markets}

---

TOP / WORLD NEWS HEADLINES (sorted by source count; pick the 4–6 most important; give expanded treatment to high-count stories; skip minor stories):
${data.topItems}

---

NYC NEWS HEADLINES (sorted by source count; pick the 4–6 most relevant to someone living in StuyTown):
${data.nycItems}

---

ARTS FEED (sorted by source count; ONLY include an Arts section if there are 1–3 genuinely noteworthy items; OMIT ENTIRELY if nothing meets the bar):
${data.artsItems}

---

OUTPUT: Return ONLY the complete HTML document — no markdown, no explanation, no code fences. Start with <!DOCTYPE html>.

Also, on the VERY LAST LINE after the closing </html> tag, output a JSON object (on one line) with this exact shape — this is machine-readable and NOT displayed to the user:
{"summary":"2-3 sentence summary of the top stories for use in the Pushover notification and manifest.json. Should stand alone as a briefing tease."}`;
}
