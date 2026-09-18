import type {
  VenueResult,
  VenueError,
  FundingResponse,
} from "./types";

/** Symbol allowlist per plan §6 — no user input reaches venue query params unescaped */
export const SYMBOL_RE = /^[A-Za-z0-9\-_:]{1,32}$/;

export const ALL_VENUES = ["hyperliquid", "binance", "dydx"] as const;
export type VenueId = (typeof ALL_VENUES)[number];

export function isVenueId(v: string): v is VenueId {
  return (ALL_VENUES as readonly string[]).includes(v);
}

/** Default markets per plan §3: BTC/ETH + venue top-10 by OI */
export const CORE_MARKETS = ["BTC", "ETH"] as const;

/** Hyperliquid asset names differ from Binance/dYdX: BTC vs BTCUSDT vs BTC-USD */
export function venueMarket(venue: VenueId, market: string): string | null {
  const m = market.toUpperCase();
  if (venue === "binance") return `${m}USDT`;
  if (venue === "dydx") return `${m}-USD`;
  return m; // hyperliquid uses bare names: BTC, ETH
}

const HOUR_MS = 3_600_000;

/** ceil to next UTC hour (Hyperliquid/dYdX hourly funding) */
export function nextUtcHour(nowMs: number): number {
  return (Math.floor(nowMs / HOUR_MS) + 1) * HOUR_MS;
}

/** dYdX native funding is 1h; 8h-equivalent = 1h * 8 */
export function dydx8h(oneHourRate: number): number {
  return oneHourRate * 8;
}

/** Hyperliquid native funding is per-hour (decimal); 8h-equivalent = hourly * 8 */
export function hyperliquid8h(oneHourRate: number): number {
  return oneHourRate * 8;
}

/** Binance native period is 8h normally; 4h on some high-vol symbols. Derive from nextFundingTime. */
export function binanceNativePeriodMs(
  prevFundingTime: number,
  nextFundingTime: number,
): number {
  const delta = nextFundingTime - prevFundingTime;
  if (delta === 2 * HOUR_MS || delta === 4 * HOUR_MS) return delta;
  return 8 * HOUR_MS;
}

/**
 * Normalize a venue's native funding rate to the 8h-equivalent rate (plan §4).
 * Binance: premiumIndex gives lastFundingRate already over its native period.
 */
export function to8hEquivalent(nativeRate: number, nativePeriodHours: number): number {
  return (nativeRate * 8) / nativePeriodHours;
}

export function nowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

export function emptyResponse(): FundingResponse {
  return {
    output: { results: [], errors: [] },
    usage: {
      venues_queried: 0,
      venues_ok: 0,
      venues_errored: 0,
      markets_returned: 0,
      duration_ms: 0,
    },
  };
}

export function addResult(r: FundingResponse, res: VenueResult): void {
  r.output.results.push(res);
  r.usage.markets_returned += 1;
}

export function addError(
  r: FundingResponse,
  venue: string,
  error: string,
  market?: string,
): void {
  const e: VenueError = { venue, error };
  if (market !== undefined) e.market = market;
  r.output.errors.push(e);
}
