/**
 * markets.ts — Fetch market data from Yahoo Finance (unofficial API)
 *
 * No API key required. Uses the public chart endpoint.
 * If a fetch fails, returns null for that instrument — Claude handles gracefully.
 */

export interface Instrument {
  symbol: string;
  name: string;
  price: number;
  previousClose: number;
  changePercent: number;
  currency: string;
  marketState: string;  // "REGULAR", "PRE", "POST", "CLOSED"
}

export interface MarketData {
  sp500: Instrument | null;
  nasdaq: Instrument | null;
  brentCrude: Instrument | null;
  bitcoin: Instrument | null;
  fetchedAt: string;   // ISO timestamp
}

const INSTRUMENTS = [
  { symbol: '%5EGSPC',  name: 'S&P 500',      currency: 'USD' },
  { symbol: '%5EIXIC',  name: 'Nasdaq',        currency: 'USD' },
  { symbol: 'BZ%3DF',   name: 'Brent Crude',   currency: 'USD' },
  { symbol: 'BTC-USD',  name: 'Bitcoin',       currency: 'USD' },
];

async function fetchInstrument(sym: typeof INSTRUMENTS[0]): Promise<Instrument | null> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym.symbol}?interval=1d&range=2d`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    });

    if (!res.ok) {
      console.warn(`[markets] ${sym.name}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json() as any;
    const meta = data?.chart?.result?.[0]?.meta;

    if (!meta) {
      console.warn(`[markets] ${sym.name}: unexpected response shape`);
      return null;
    }

    const price = meta.regularMarketPrice as number;
    const previousClose = (meta.chartPreviousClose ?? meta.previousClose) as number;
    const changePercent = previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : 0;

    return {
      symbol: meta.symbol ?? sym.name,
      name: sym.name,
      price,
      previousClose,
      changePercent: Math.round(changePercent * 100) / 100,
      currency: sym.currency,
      marketState: meta.marketState ?? 'UNKNOWN',
    };
  } catch (err) {
    console.warn(`[markets] ${sym.name}: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchMarketData(): Promise<MarketData> {
  console.log('[markets] Fetching market data…');
  const [sp500, nasdaq, brentCrude, bitcoin] = await Promise.all(
    INSTRUMENTS.map(i => fetchInstrument(i))
  );

  return {
    sp500,
    nasdaq,
    brentCrude,
    bitcoin,
    fetchedAt: new Date().toISOString(),
  };
}

export function formatChangePercent(pct: number): string {
  const sign = pct >= 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
}

export function formatPrice(price: number, decimals = 2): string {
  return price.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
