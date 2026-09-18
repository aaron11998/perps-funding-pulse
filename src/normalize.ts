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

/**
 * Binance native funding period, derived keylessly from nextFundingTime.
 * Binance schedules funding at fixed UTC boundaries; a symbol's next slot is
 * always a multiple of its native period. Largest interval in {8h,4h,2h,1h}
 * that divides the venue-provided nextFundingTime wins. Fixture-verified
 * 2026-09-18: 850/900 symbols classify as 8h, 13 as hourly (top-of-hour
 * slots off the 8h grid), 37 have nextFundingTime=0 (settle-only → default 8h).
 * The old `gap = nextFundingTime - time` heuristic was wrong: that gap is
 * time-UNTIL-next-funding, not the interval (it misclassified 95.9% of symbols).
 */
const BINANCE_PERIODS_H = [8, 4, 2, 1] as const;

export function binancePeriodHours(nextFundingTime: number): number {
  if (!Number.isFinite(nextFundingTime) || nextFundingTime <= 0) return 8;
  for (const h of BINANCE_PERIODS_H) {
    if (nextFundingTime % (h * 3_600_000) === 0) return h;
  }
  return 8;
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
