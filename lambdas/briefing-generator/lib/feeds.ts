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

  // NYC local news
  { category: 'nyc', name: 'Gothamist',          url: 'https://gothamist.com/feed' },
  { category: 'nyc', name: 'The City',           url: 'https://www.thecity.nyc/feed' },
  { category: 'nyc', name: 'NBC New York',       url: 'https://www.nbcnewyork.com/feed/' },
  { category: 'nyc', name: 'NY Post',            url: 'https://nypost.com/feed/' },
  { category: 'nyc', name: 'NYT NY Region',      url: 'https://rss.nytimes.com/services/xml/rss/nyt/NYRegion.xml' },
  { category: 'nyc', name: 'Brooklyn Paper',     url: 'https://www.brooklynpaper.com/feed/' },

  // Arts — NYC and nationally significant
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

  // Deduplicate within each category by title similarity
  grouped.top = deduplicate(grouped.top);
  grouped.nyc = deduplicate(grouped.nyc);
  grouped.arts = deduplicate(grouped.arts);

  console.log(`[feeds] Totals — top:${grouped.top.length} nyc:${grouped.nyc.length} arts:${grouped.arts.length}`);
  return grouped;
}

/** Remove near-duplicate headlines (same first 60 chars) */
function deduplicate(items: FeedItem[]): FeedItem[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = item.title.toLowerCase().slice(0, 60).replace(/\s+/g, ' ');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
