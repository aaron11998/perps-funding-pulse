import type {
  HyperliquidMetaAndAssetCtxs,
  BinancePremiumIndexEntry,
  BinanceOpenInterest,
  DydxPerpetualMarkets,
  VenueResult,
} from "./types";
import {
  nextUtcHour,
  to8hEquivalent,
  nowIso,
  binancePeriodHours,
} from "./normalize";

/** Venue API base URLs — injectable for tests */
export const VENUE_BASES = {
  hyperliquid: "https://api.hyperliquid.xyz",
  binance: "https://fapi.binance.com",
  dydx: "https://indexer.dydx.trade",
} as const;

export type VenueKey = keyof typeof VENUE_BASES;

const FETCH_TIMEOUT_MS = 5_000;

/** Single fanout per request — no retry storms (plan §5.5) */
export async function fetchVenueJson(
  base: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${path}`, { ...init, signal: ctrl.signal });
    if (!res.ok) {
      throw new Error(`venue HTTP ${res.status}`);
    }
    return (await res.json()) as unknown;
  } finally {
    clearTimeout(timer);
  }
}

/** Extract an LSIID from a Binance symbol like BTCUSDT -> BTC */
export function binanceBase(symbol: string): string | null {
  const m = /^(.+)(USDT|USDC)$/.exec(symbol);
  return m && m[1] ? m[1] : null;
}

/** Filter Binance premiumIndex to requested base symbols */
export function pickBinance<T extends BinancePremiumIndexEntry>(
  entries: T[],
  bases: Set<string>,
): T[] {
  return entries.filter((e) => {
    const b = binanceBase(e.symbol);
    return b !== null && bases.has(b);
  });
}

/**
 * USDT is the flagship perp pair; USDC-margined mirrors of the same base would
 * produce two rows per market with silently different OI/mark data. Prefer
 * USDT deterministically, fall back to USDC when only that pair exists.
 * Fixture-verified 2026-09-18: 39/196 bases have BOTH pairs.
 */
export function dedupeBinance<T extends BinancePremiumIndexEntry>(
  entries: T[],
): T[] {
  const byBase = new Map<string, T>();
  for (const e of entries) {
    const base = binanceBase(e.symbol);
    if (!base) continue;
    const prev = byBase.get(base);
    if (!prev) {
      byBase.set(base, e);
      continue;
    }
    const prevUsdt = prev.symbol.endsWith("USDT");
    const curUsdt = e.symbol.endsWith("USDT");
    if (curUsdt && !prevUsdt) byBase.set(base, e);
  }
  return [...byBase.values()];
}

/**
 * Hyperliquid normalization. Funding is per-hour raw (plan §4); 8h-equiv = *8.
 * skew = premium/markPx signal. time_to_next = ceil to next UTC hour.
 */
export function normalizeHyperliquid(
  data: HyperliquidMetaAndAssetCtxs,
  markets: string[],
  nowMs: number,
): VenueResult[] {
  const out: VenueResult[] = [];
  // Live API shape: [meta, assetCtxs] parallel arrays (fixture-verified 2026-09-18)
  const [meta, ctxs] = Array.isArray(data) ? data : [{ universe: [] }, []];
  const universe = meta?.universe ?? [];
  const want = new Set(markets.map((m) => m.toUpperCase()));
  const nextHour = nextUtcHour(nowMs);

  universe.forEach((asset, i) => {
    const ctx = ctxs[i];
    if (!ctx || !want.has(asset.name.toUpperCase())) return;
    const hourly = Number(ctx.funding);
    const mark = Number(ctx.markPx);
    const premium = Number(ctx.premium);
    const oi = Number(ctx.openInterest);
    out.push({
      venue: "hyperliquid",
      market: asset.name.toUpperCase(),
      funding_rate_8h: to8hEquivalent(hourly, 1),
      native_period: "1h",
      funding_rate_native: hourly,
      time_to_next_seconds: Math.max(0, Math.round((nextHour - nowMs) / 1000)),
      next_funding_time_utc: new Date(nextHour).toISOString(),
      open_interest: Number.isFinite(oi) ? oi : null,
      skew: Number.isFinite(premium) ? premium : null,
      mark_price: Number.isFinite(mark) ? mark : null,
      source_ts: nowIso(nowMs),
    });
  });
  return out;
}

/**
 * Binance normalization. premiumIndex gives lastFundingRate over the native
 * period (8h standard, 4h on some symbols). nextFundingTime is venue-provided
 * (plan §5.6 clock-skew rule). OI comes from a second endpoint — attached when
 * available, else null.
 */
export function normalizeBinance(
  premium: BinancePremiumIndexEntry[],
  oiByBase: Map<string, BinanceOpenInterest>,
  markets: string[],
  nowMs: number,
): VenueResult[] {
  const out: VenueResult[] = [];
  const want = new Set(markets.map((m) => m.toUpperCase()));

  for (const e of dedupeBinance(premium)) {
    const base = binanceBase(e.symbol);
    if (!base || !want.has(base)) continue;
    const rate = Number(e.lastFundingRate);
    const mark = Number(e.markPrice);
    const idx = Number(e.indexPrice);
    const nextT = e.nextFundingTime;
    // Native period from venue-scheduled nextFundingTime (UTC-alignment rule —
    // see binancePeriodHours). nextT=0 → unknown period, default 8h.
    const periodHours = binancePeriodHours(nextT);
    const skew = Number.isFinite(idx) && idx !== 0 ? (mark - idx) / idx : null;
    const oi = oiByBase.get(base);
    const oiVal = oi ? Number(oi.openInterest) : NaN;
    out.push({
      venue: "binance",
      market: base,
      funding_rate_8h: to8hEquivalent(rate, periodHours),
      native_period: `${periodHours}h`,
      funding_rate_native: rate,
      time_to_next_seconds: nextT > 0 ? Math.max(0, Math.round((nextT - nowMs) / 1000)) : null,
      next_funding_time_utc: nextT > 0 ? new Date(nextT).toISOString() : null,
      open_interest: Number.isFinite(oiVal) ? oiVal : null,
      skew,
      mark_price: Number.isFinite(mark) ? mark : null,
      source_ts: nowIso(e.time > 0 ? e.time : nowMs),
    });
  }
  return out;
}

/**
 * dYdX normalization. nextFundingRate is the upcoming 1h rate; defaultFundingRate1H
 * is a fallback when next is absent. skew proxy = priceChange24H / oraclePrice (plan §4).
 */
export function normalizeDydx(
  data: DydxPerpetualMarkets,
  markets: string[],
  nowMs: number,
): VenueResult[] {
  const out: VenueResult[] = [];
  const want = new Set(markets.map((m) => m.toUpperCase()));
  const nextHour = nextUtcHour(nowMs);

  for (const [key, m] of Object.entries(data.markets ?? {})) {
    const base = key.replace(/-USD$/, "");
    if (!want.has(base)) continue;
    // Settled markets have no live funding signal — exclude, not null-fill (fixture: 218/296 FINAL_SETTLEMENT)
    if (m.status && m.status !== "ACTIVE") continue;
    const rateRaw = m.nextFundingRate ?? m.defaultFundingRate1H ?? null;
    // Number("") === 0 in JS — an empty string must be "missing", not a 0% rate
    const rateNum =
      rateRaw !== null && String(rateRaw).trim() !== "" ? Number(rateRaw) : NaN;
    const rate = Number.isFinite(rateNum) ? rateNum : null;
    const oracle = Number(m.oraclePrice);
    const chg = Number(m.priceChange24H);
    const oi = Number(m.openInterest);
    out.push({
      venue: "dydx",
      market: base,
      funding_rate_8h: rate !== null ? to8hEquivalent(rate, 1) : null,
      native_period: "1h",
      funding_rate_native: rate,
      time_to_next_seconds: Math.max(0, Math.round((nextHour - nowMs) / 1000)),
      next_funding_time_utc: new Date(nextHour).toISOString(),
      open_interest: Number.isFinite(oi) ? oi : null,
      skew: Number.isFinite(oracle) && oracle !== 0 && Number.isFinite(chg) ? chg / oracle : null,
      mark_price: Number.isFinite(oracle) ? oracle : null,
      source_ts: nowIso(nowMs),
    });
  }
  return out;
}
