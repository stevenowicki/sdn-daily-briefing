/**
 * feeds.ts — RSS feed definitions and fetcher
 *
 * To add or remove sources, edit the FEED_GROUPS constant below.
 * Each feed fetch is independent; a single feed failure never aborts the run.
 */

import { XMLParser } from 'fast-xml-parser';

export interface FeedItem {
  title: string;
  summary: string;
  link: string;
  pubDate: string;
  source: string;
  /** How many distinct sources mentioned this story (set by deduplication) */
  sourceCount?: number;
  /** All source names that covered this story (first = primary) */
  allSources?: string[];
}

export interface FeedGroup {
  category: 'top' | 'us' | 'nyc' | 'arts';
  name: string;
  url: string;
  /** Max items to pull from this feed */
  maxItems?: number;
}

// ---------------------------------------------------------------------------
// Feed registry — edit here to change sources
// ---------------------------------------------------------------------------
export const FEED_GROUPS: FeedGroup[] = [
  // Top / World news
  { category: 'top', name: 'CNN',                url: 'http://rss.cnn.com/rss/cnn_topstories.rss' },
  { category: 'top', name: 'NPR',                url: 'https://feeds.npr.org/1001/rss.xml' },
  { category: 'top', name: 'New York Times',     url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { category: 'top', name: 'BBC World',          url: 'http://feeds.bbci.co.uk/news/world/rss.xml' },
  { category: 'top', name: 'PBS NewsHour',       url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },
  { category: 'top', name: 'ABC News',           url: 'https://feeds.abcnews.com/abcnews/topstories' },
  { category: 'top', name: 'CBS News',           url: 'https://www.cbsnews.com/latest/rss/main' },
  { category: 'top', name: 'Washington Post',    url: 'https://feeds.washingtonpost.com/rss/world' },
  { category: 'top', name: 'Washington Post US', url: 'https://feeds.washingtonpost.com/rss/national' },
  { category: 'top', name: 'Reuters',            url: 'https://feeds.reuters.com/reuters/topNews' },
  { category: 'top', name: 'Reuters US',         url: 'https://feeds.reuters.com/Reuters/domesticNews' },

  // NYC local news
  { category: 'nyc', name: 'Gothamist',          url: 'https://gothamist.com/feed' },
  { category: 'nyc', name: 'The City',           url: 'https://www.thecity.nyc/feed' },
  { category: 'nyc', name: 'NBC New York',       url: 'https://www.nbcnewyork.com/feed/' },
  { category: 'nyc', name: 'NY Post',            url: 'https://nypost.com/feed/' },
  { category: 'nyc', name: 'NYT NY Region',      url: 'https://rss.nytimes.com/services/xml/rss/nyt/NYRegion.xml' },
  { category: 'nyc', name: 'Brooklyn Paper',     url: 'https://www.brooklynpaper.com/feed/' },
  { category: 'nyc', name: 'NY1',                url: 'https://ny1.com/services/contentfeed.nyc%7call-boroughs%7cnews.landing.rss' },

  // Arts — NYC and nationally significant
  { category: 'arts', name: 'Reuters Entertainment', url: 'https://feeds.reuters.com/reuters/entertainment' },
  { category: 'arts', name: 'BroadwayWorld',     url: 'https://www.broadwayworld.com/rss.cfm' },
  { category: 'arts', name: 'NYT Arts',          url: 'https://rss.nytimes.com/services/xml/rss/nyt/Arts.xml' },
  { category: 'arts', name: 'NYT Theater',       url: 'https://rss.nytimes.com/services/xml/rss/nyt/Theater.xml' },
  { category: 'arts', name: 'TheaterMania',      url: 'https://www.theatermania.com/rss/' },
  { category: 'arts', name: 'ArtsJournal',       url: 'https://www.artsjournal.com/feed' },
  { category: 'arts', name: 'Hyperallergic',     url: 'https://hyperallergic.com/feed/' },
  { category: 'arts', name: 'Slippedisc',        url: 'https://slippedisc.com/feed/' },
  { category: 'arts', name: 'Variety Legit',     url: 'https://variety.com/v/legit/feed/' },
  { category: 'arts', name: 'Deadline',          url: 'https://deadline.com/feed/' },
  { category: 'arts', name: 'Hollywood Reporter',url: 'https://www.hollywoodreporter.com/feed/' },
];

// ---------------------------------------------------------------------------
// Fetch + parse a single RSS/Atom feed
// ---------------------------------------------------------------------------
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
});

async function fetchOneFeed(feed: FeedGroup, timeoutMs = 8000): Promise<FeedItem[]> {
  const maxItems = feed.maxItems ?? 12;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(feed.url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; briefings-bot/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });

    if (!res.ok) {
      console.warn(`[feeds] ${feed.name}: HTTP ${res.status}`);
      return [];
    }

    const xml = await res.text();
    const parsed = parser.parse(xml);

    // Handle both RSS 2.0 and Atom
    const channel = parsed?.rss?.channel;
    const atomFeed = parsed?.feed;

    let rawItems: any[] = [];
    if (channel) {
      rawItems = Array.isArray(channel.item) ? channel.item : channel.item ? [channel.item] : [];
    } else if (atomFeed) {
      rawItems = Array.isArray(atomFeed.entry) ? atomFeed.entry : atomFeed.entry ? [atomFeed.entry] : [];
    }

    return rawItems.slice(0, maxItems).map((item: any): FeedItem => {
      const title = stripHtml(String(item.title?.['#text'] ?? item.title ?? '')).trim();
      const description =
        stripHtml(String(item.description?.['#text'] ?? item.description ?? item.summary?.['#text'] ?? item.summary ?? item.content?.['#text'] ?? item.content ?? '')).trim();
      const link = String(item.link?.['@_href'] ?? item.link?.['#text'] ?? item.link ?? item.id ?? '').trim();
      const pubDate = String(item.pubDate ?? item.updated ?? item.published ?? '').trim();

      return { title, summary: description.slice(0, 400), link, pubDate, source: feed.name };
    }).filter(i => i.title.length > 0);

  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      console.warn(`[feeds] ${feed.name}: timed out after ${timeoutMs}ms`);
    } else {
      console.warn(`[feeds] ${feed.name}: ${String(err)}`);
    }
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Fetch all feeds concurrently, grouped by category
// ---------------------------------------------------------------------------
export interface AllFeedItems {
  top: FeedItem[];
  nyc: FeedItem[];
  arts: FeedItem[];
}

export async function fetchAllFeeds(): Promise<AllFeedItems> {
  console.log('[feeds] Fetching all feeds concurrently…');
  const results = await Promise.allSettled(
    FEED_GROUPS.map(feed => fetchOneFeed(feed))
  );

  const grouped: AllFeedItems = { top: [], nyc: [], arts: [] };

  results.forEach((result, i) => {
    const feed = FEED_GROUPS[i];
    if (result.status === 'fulfilled') {
      const items = result.value;
      console.log(`[feeds] ${feed.name}: ${items.length} items`);
      grouped[feed.category as keyof AllFeedItems]?.push(...items);
    }
  });

  // Deduplicate within each category by title similarity; annotate with source counts
  grouped.top = deduplicateWithCounts(grouped.top);
  grouped.nyc = deduplicateWithCounts(grouped.nyc);
  grouped.arts = deduplicateWithCounts(grouped.arts);

  console.log(`[feeds] Totals — top:${grouped.top.length} nyc:${grouped.nyc.length} arts:${grouped.arts.length}`);
  return grouped;
}

/**
 * Deduplicate near-duplicate headlines (same first 60 chars) and annotate
 * each surviving item with how many distinct sources covered the story.
 * Results are sorted by source count descending so Claude sees the most
 * widely-covered story first — a proxy for news prominence.
 */
function deduplicateWithCounts(items: FeedItem[]): FeedItem[] {
  // Group items by title key
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    const key = item.title.toLowerCase().slice(0, 60).replace(/\s+/g, ' ');
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  // For each group, keep the first item but annotate with all source names
  const deduped = Array.from(groups.values()).map(group => {
    const primary = group[0];
    // Deduplicate source names within the group (same source can appear multiple times)
    const allSources = [...new Set(group.map(i => i.source))];
    return { ...primary, sourceCount: allSources.length, allSources };
  });

  // Sort by source count descending — stories covered by more outlets rank higher
  deduped.sort((a, b) => (b.sourceCount ?? 1) - (a.sourceCount ?? 1));
  return deduped;
}
