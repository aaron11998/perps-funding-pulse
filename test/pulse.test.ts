/**
 * Test matrix per LOCKED plan §8: normalization, validation, error paths,
 * golden-fixture contract. No network: venue payloads come from committed
 * fixtures; error paths via dependency-injected fetcher.
 */
import { describe, it, expect } from "vitest";
import { to8hEquivalent, nextUtcHour, venueMarket, SYMBOL_RE } from "../src/normalize";
import { parseBody } from "../src/validate";
import {
  normalizeHyperliquid,
  normalizeBinance,
  normalizeDydx,
  fetchVenueJson,
  VENUE_BASES,
} from "../src/venues";
import { gather } from "../src/index";
import hlFixture from "../fixtures/raw_hyperliquid_metaAndAssetCtxs.json";
import bnFixture from "../fixtures/raw_binance_premiumIndex.json";

const HOUR = 3_600_000;

describe("normalization", () => {
  it("8h-equivalent math: 1h venue *8, 8h venue identity, 4h venue *2", () => {
    expect(to8hEquivalent(0.00001, 1)).toBeCloseTo(0.00008, 12);
    expect(to8hEquivalent(0.0001, 8)).toBeCloseTo(0.0001, 12);
    expect(to8hEquivalent(0.00005, 4)).toBeCloseTo(0.0001, 12);
  });

  it("nextUtcHour ceils to the next top-of-hour UTC", () => {
    expect(nextUtcHour(Date.UTC(2026, 8, 18, 7, 30, 0))).toBe(Date.UTC(2026, 8, 18, 8, 0, 0));
    expect(nextUtcHour(Date.UTC(2026, 8, 18, 8, 0, 0))).toBe(Date.UTC(2026, 8, 18, 9, 0, 0));
  });

  it("venue market naming: BTC → BTC / BTCUSDT / BTC-USD", () => {
    expect(venueMarket("hyperliquid", "btc")).toBe("BTC");
    expect(venueMarket("binance", "BTC")).toBe("BTCUSDT");
    expect(venueMarket("dydx", "eth")).toBe("ETH-USD");
  });

  it("hyperliquid fixture normalizes funding/skew/oi per market", () => {
    const now = Date.UTC(2026, 8, 18, 7, 30, 0);
    const rows = normalizeHyperliquid(hlFixture as never, ["BTC", "ETH"], now);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const btc = rows.find((r) => r.market === "BTC");
    expect(btc).toBeTruthy();
    expect(btc!.native_period).toBe("1h");
    expect(btc!.funding_rate_8h).toBeCloseTo(btc!.funding_rate_native * 8, 12);
    expect(btc!.time_to_next_seconds).toBeGreaterThan(0);
    expect(btc!.time_to_next_seconds).toBeLessThanOrEqual(3600);
    expect(btc!.next_funding_time_utc).toMatch(/:00:00\.000Z$/);
  });

  it("binance fixture normalizes with venue-provided nextFundingTime", () => {
    const entries = Array.isArray(bnFixture)
      ? bnFixture
      : ((bnFixture as unknown as { entries: unknown[] }).entries ?? []);
    expect(entries.length).toBeGreaterThan(0);
    const first = entries[0] as { time: number };
    const now = first.time + 1000;
    const rows = normalizeBinance(entries as never, new Map(), ["BTC", "ETH"], now);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    const btc = rows.find((r) => r.market === "BTC");
    expect(btc).toBeTruthy();
    expect(["4h", "8h"]).toContain(btc!.native_period);
    expect(btc!.time_to_next_seconds).toBeGreaterThan(0);
  });

  it("dYdX derives skew proxy only when both prices exist — never fabricated", () => {
    const now = Date.UTC(2026, 8, 18, 7, 0, 0);
    const rows = normalizeDydx(
      {
        markets: {
          "BTC-USD": {
            ticker: "BTC-USD", status: "ACTIVE", oraclePrice: "100", priceChange24H: "1",
            nextFundingRate: "0.00001", defaultFundingRate1H: "0.000005",
            openInterest: "12", volume24H: "1",
          },
          "ETH-USD": {
            ticker: "ETH-USD", status: "ACTIVE", oraclePrice: "0", priceChange24H: "1",
            nextFundingRate: "0.00001", defaultFundingRate1H: "0.000005",
            openInterest: "3", volume24H: "1",
          },
        },
      },
      ["BTC", "ETH"],
      now,
    );
    const btc = rows.find((r) => r.market === "BTC");
    const eth = rows.find((r) => r.market === "ETH");
    expect(btc!.skew).toBeCloseTo(0.01, 10);
    expect(eth!.skew).toBeNull(); // oracle 0 → null, not a fake number
    expect(eth!.funding_rate_native).toBeCloseTo(0.00001, 15);
  });
});

describe("validation (plan §8)", () => {
  it("symbol allowlist blocks injection, oversize, whitespace", () => {
    expect(SYMBOL_RE.test("BTC")).toBe(true);
    expect(SYMBOL_RE.test("BTC; DROP TABLE")).toBe(false);
    expect(SYMBOL_RE.test("x".repeat(40))).toBe(false);
  });

  it("parseBody rejects malformed bodies as validation errors, not 500s", () => {
    expect(parseBody({ markets: ["x".repeat(60)] }).ok).toBe(false);
    expect(parseBody({ venue_ids: "not-an-array" }).ok).toBe(false);
    expect(parseBody({ venue_ids: ["hyperliquid"], markets: ["BTC"] }).ok).toBe(true);
  });
});

describe("error paths (plan §5.1: one dead venue never kills a paid call)", () => {
  it("gather returns partial results + per-venue error entry on venue failure", async () => {
    const poisoned = async (base: string, path: string, init?: RequestInit) => {
      if (base === VENUE_BASES.dydx) throw new Error("venue HTTP 503");
      return fetchVenueJson(base, path, init);
    };
    const resp = await gather(["hyperliquid", "dydx"], ["BTC"], Date.now(), poisoned);
    expect(resp.usage.venues_queried).toBe(2);
    expect(resp.usage.venues_ok).toBe(1);
    expect(resp.usage.venues_errored).toBe(1);
    expect(resp.output.errors.map((e) => e.venue)).toContain("dydx");
    expect(resp.output.results.some((r) => r.venue === "hyperliquid")).toBe(true);
  }, 20000);

  it("all venues down → 200 with empty results and 3 error entries", async () => {
    const dead = async () => {
      throw new Error("venue HTTP 500");
    };
    const resp = await gather(["hyperliquid", "binance", "dydx"], ["BTC"], Date.now(), dead);
    expect(resp.output.results.length).toBe(0);
    expect(resp.output.errors.length).toBe(3);
    expect(resp.usage.venues_errored).toBe(3);
  });

  it("golden fixture contract: results carry the full §3 field set", () => {
    const now = Date.UTC(2026, 8, 18, 7, 30, 0);
    const rows = normalizeHyperliquid(hlFixture as never, ["BTC"], now);
    const btc = rows[0]!;
    for (const key of [
      "venue", "market", "funding_rate_8h", "native_period", "funding_rate_native",
      "time_to_next_seconds", "next_funding_time_utc", "open_interest", "skew",
      "mark_price", "source_ts",
    ]) {
      expect(btc).toHaveProperty(key);
    }
  });
});
