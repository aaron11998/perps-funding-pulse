/**
 * Shared types for perps-funding-pulse.
 * Response shape per LOCKED plan §3/§4 — agent-kit-entrypoint-compatible {output, usage}.
 */

export interface VenueResult {
  venue: string;
  market: string;
  /** 8h-equivalent raw funding rate (decimal, e.g. 0.0001 = 0.01% per 8h); null when venue provides none */
  funding_rate_8h: number | null;
  /** Native period the venue quotes funding for */
  native_period: string;
  /** Funding rate as the venue quotes it (raw decimal over native period); null when unknown */
  funding_rate_native: number | null;
  /** Seconds until venue's next funding event; null when venue gives no timestamp */
  time_to_next_seconds: number | null;
  next_funding_time_utc: string | null;
  open_interest: number | null;
  /** premium/skew signal; null when venue provides none — never fabricated (plan §4) */
  skew: number | null;
  mark_price: number | null;
  source_ts: string;
}

export interface VenueError {
  venue: string;
  market?: string;
  error: string;
}

export interface Usage {
  venues_queried: number;
  venues_ok: number;
  venues_errored: number;
  markets_returned: number;
  duration_ms: number;
}

export interface FundingResponse {
  output: {
    results: VenueResult[];
    errors: VenueError[];
  };
  usage: Usage;
}

/** Venue-side raw payloads we normalize from */
/** Hyperliquid info returns a 2-tuple: [meta, assetCtxs] (parallel arrays) — live-captured 2026-09-18 */
export type HyperliquidMetaAndAssetCtxs = [
  {
    universe: { name: string; szDecimals: number; maxLeverage: number }[];
  },
  {
    funding: string;
    openInterest: string;
    markPx: string;
    midPx: string;
    oraclePx: string;
    premium: string;
    prevDayPx: string;
    dayNtlVlm: string;
  }[],
];

export interface BinancePremiumIndexEntry {
  symbol: string;
  markPrice: string;
  indexPrice: string;
  lastFundingRate: string;
  nextFundingTime: number;
  time: number;
}

export interface BinanceOpenInterest {
  symbol: string;
  openInterest: string;
  time: number;
}

export interface DydxPerpetualMarkets {
  markets: Record<
    string,
    {
      ticker: string;
      status: string;
      oraclePrice: string;
      priceChange24H: string;
      nextFundingRate: string;
      defaultFundingRate1H: string;
      openInterest: string;
      volume24H: string;
    }
  >;
}
