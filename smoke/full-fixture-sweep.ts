import fs from "fs";
import { normalizeBinance, normalizeHyperliquid, normalizeDydx } from "../src/venues";

const bn = JSON.parse(fs.readFileSync("fixtures/raw_binance_premiumIndex.json", "utf8"));
const hl = JSON.parse(fs.readFileSync("fixtures/raw_hyperliquid_metaAndAssetCtxs.json", "utf8"));
const dx = JSON.parse(fs.readFileSync("fixtures/raw_dydx_perpetualMarkets.json", "utf8"));
const now = 1789683399006;

// Binance: request every base present in the fixture
const bases = Array.from(new Set(bn.map((e: { symbol: string }) => e.symbol.replace(/(USDT|USDC)$/, ""))));
const bnRows = normalizeBinance(bn, new Map(), bases, now);
const bnMarkets = new Set(bnRows.map((r) => r.market));
console.log("binance: fixture entries", bn.length, "-> rows", bnRows.length, "unique markets", bnMarkets.size);
const periods: Record<string, number> = {};
bnRows.forEach((r) => (periods[r.native_period] = (periods[r.native_period] ?? 0) + 1));
console.log("binance period distribution:", JSON.stringify(periods));
const btc = bnRows.find((r) => r.market === "BTC")!;
console.log("binance BTC:", btc.native_period, "8h-equiv", btc.funding_rate_8h, "native", btc.funding_rate_native);
const badSched = bnRows.filter(
  (r) => (r.next_funding_time_utc === null) !== (r.time_to_next_seconds === null),
);
console.log("binance schedule-field consistency violations:", badSched.length);

// Hyperliquid: full universe
const hlNames = hl[0].universe.map((u: { name: string }) => u.name);
const hlRows = normalizeHyperliquid(hl, hlNames, now);
console.log("hyperliquid: universe", hlNames.length, "-> rows", hlRows.length);
const btcHl = hlRows.find((r) => r.market === "BTC")!;
console.log(
  "hyperliquid BTC: 8h-equiv",
  btcHl.funding_rate_8h,
  "native",
  btcHl.funding_rate_native,
  "ratio(should be 8):",
  (btcHl.funding_rate_8h / btcHl.funding_rate_native!).toFixed(2),
);

// dYdX: full market dict
const dxKeys = Object.keys(dx.markets).map((k) => k.replace(/-USD$/, ""));
const dxRows = normalizeDydx(dx, dxKeys, now);
const activeCount = Object.values(dx.markets).filter((m) => m.status === "ACTIVE").length;
console.log("dydx: markets", dxKeys.length, "(ACTIVE:", activeCount + ") -> rows", dxRows.length);

// NaN / Infinity must never reach serialized output
const all = [...bnRows, ...hlRows, ...dxRows];
let nanLeaks = 0;
for (const r of all) {
  const s = JSON.stringify(r);
  if (s.includes("NaN") || s.includes("Infinity")) nanLeaks++;
}
console.log("NaN/Infinity leaks across", all.length, "rows:", nanLeaks);
