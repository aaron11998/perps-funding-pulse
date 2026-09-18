/**
 * perps-funding-pulse — Workers entrypoint (bounty #8, GStack tech plan v1 §2-§4).
 * Free: GET /health, GET /.well-known/x402.json.
 * Paid: POST /funding — $0.01, network eip155:8453 (Base), USDC.
 * No private keys anywhere (plan §6): paymentMiddleware only VERIFIES payment.
 */
import { Hono } from "hono";
import { paymentMiddleware } from "x402-hono";
import {
  ALL_VENUES,
  CORE_MARKETS,
  isVenueId,
  venueMarket,
  emptyResponse,
  addResult,
  addError,
  type VenueId,
} from "./normalize";
import { parseBody } from "./validate";
import {
  VENUE_BASES,
  fetchVenueJson,
  normalizeHyperliquid,
  normalizeBinance,
  normalizeDydx,
} from "./venues";
import type {
  FundingResponse,
  BinancePremiumIndexEntry,
  BinanceOpenInterest,
} from "./types";

const X402_NETWORK = "eip155:8453";
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

type Bindings = { ORG_EVM_PAYTO: string };

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "perps-funding-pulse",
    venues: ALL_VENUES,
    x402: { network: X402_NETWORK, asset: USDC_BASE, price: "$0.01/call" },
  }),
);

app.get("/.well-known/x402.json", (c) =>
  c.json({
    x402Version: 2,
    resource: "/funding",
    description:
      "Perps funding-rate pulse: funding rates, OI, skew across Hyperliquid, Binance and dYdX",
    accepts: [
      {
        scheme: "exact",
        network: X402_NETWORK,
        asset: USDC_BASE,
        payTo: c.env.ORG_EVM_PAYTO,
        maxAmountRequired: "10000",
        resource: "/funding",
        description: "One /funding API call",
      },
    ],
    free: ["/health", "/.well-known/x402.json"],
  }),
);

/**
 * Per-request middleware wiring: Workers env vars exist only on the request
 * context, so the middleware is constructed inside the request lifecycle.
 */
app.use("/funding", async (c, next) => {
  const mw = paymentMiddleware(c.env.ORG_EVM_PAYTO as `0x${string}`, {
    "/funding": {
      price: "$0.01",
      network: "base",
      config: {
        description: "Perps funding pulse: 3-venue funding rates, OI, skew",
      },
    },
  });
  return mw(c, next);
});

/** Parallel per-venue gather; one dead venue never kills a paid call (plan §5.1). */
export async function gather(
  venueIds: VenueId[],
  markets: string[],
  nowMs: number,
  fetcher: typeof fetchVenueJson = fetchVenueJson,
): Promise<FundingResponse> {
  const r = emptyResponse();
  const started = Date.now();
  r.usage.venues_queried = venueIds.length;

  await Promise.all(
    venueIds.map(async (venue) => {
      const venueMarkets = markets
        .map((m) => venueMarket(venue, m))
        .filter((x): x is string => x !== null);
      try {
        if (venue === "hyperliquid") {
          const data = (await fetcher(VENUE_BASES.hyperliquid, "/info", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ type: "metaAndAssetCtxs" }),
          })) as Parameters<typeof normalizeHyperliquid>[0];
          for (const res of normalizeHyperliquid(data, venueMarkets, nowMs))
            addResult(r, res);
        } else if (venue === "binance") {
          const premium = (await fetcher(
            VENUE_BASES.binance,
            "/fapi/v1/premiumIndex",
          )) as BinancePremiumIndexEntry[];
          const bases = venueMarkets.map((s) => s.replace(/USDT$/, ""));
          const oiByBase = new Map<string, BinanceOpenInterest>();
          await Promise.all(
            venueMarkets.map(async (sym) => {
              try {
                const d = (await fetcher(
                  VENUE_BASES.binance,
                  `/fapi/v1/openInterest?symbol=${sym}`,
                )) as BinanceOpenInterest;
                const base = sym.replace(/USDT$/, "");
                if (base) oiByBase.set(base, d);
              } catch {
                /* OI is optional — funding is the product */
              }
            }),
          );
          for (const res of normalizeBinance(premium, oiByBase, bases, nowMs))
            addResult(r, res);
        } else if (venue === "dydx") {
          const data = (await fetcher(
            VENUE_BASES.dydx,
            "/v4/perpetualMarkets",
          )) as Parameters<typeof normalizeDydx>[0];
          for (const res of normalizeDydx(data, venueMarkets, nowMs))
            addResult(r, res);
        }
        r.usage.venues_ok += 1;
      } catch (err) {
        r.usage.venues_errored += 1;
        addError(r, venue, err instanceof Error ? err.message : String(err));
      }
    }),
  );

  r.usage.duration_ms = Date.now() - started;
  return r;
}

app.post("/funding", async (c) => {
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    /* empty body → defaults */
  }
  const parsed = parseBody(raw);
  if (!parsed.ok) {
    const error = "error" in parsed ? parsed.error : "invalid body";
    return c.json(
      {
        output: { results: [], errors: [{ venue: "request", error }] },
        usage: {
          venues_queried: 0,
          venues_ok: 0,
          venues_errored: 0,
          markets_returned: 0,
          duration_ms: 0,
        },
      },
      400,
    );
  }
  const requested = parsed.body.venue_ids ?? [...ALL_VENUES];
  const unknown = requested.filter((v) => !isVenueId(v));
  const venueIds = requested.filter((v): v is VenueId => isVenueId(v));
  const markets = parsed.body.markets?.length
    ? parsed.body.markets
    : [...CORE_MARKETS];
  const resp = await gather(venueIds, markets, Date.now());
  for (const v of unknown) addError(resp, v, "unknown venue_id");
  return c.json(resp, 200);
});

export default app;
