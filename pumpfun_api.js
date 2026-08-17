/**
 * Direct polling against pump.fun's own frontend API — a redundant
 * discovery path that runs alongside the PumpPortal websocket. Pattern
 * lifted from a known community pump.fun bot: fetch the newest coins
 * sorted by creation time, page by page, with browser-like headers.
 *
 * NOTE: frontend-api-v3.pump.fun is pump.fun's own internal frontend API,
 * not a documented/stable public API. It can rename fields, rate-limit, or
 * start blocking non-browser requests without notice. Treat this as a
 * backup signal for discovery, not a guaranteed source — it's exactly why
 * it's kept separate from (and running in parallel with) the websocket
 * feed instead of replacing it.
 */
const axios = require("axios");
const config = require("./config");

async function fetchNewestCoins() {
  try {
    const { data } = await axios.get("https://frontend-api-v3.pump.fun/coins", {
      params: {
        offset: 0,
        limit: config.COINS_PER_PAGE,
        sort: "created_timestamp",
        includeNsfw: false,
        order: "DESC",
      },
      headers: {
        Origin: "https://pump.fun",
        Referer: "https://pump.fun/",
        Accept: "application/json",
        // Cloudflare (fronting this API) appears to treat axios's default
        // "axios/1.x.x" UA differently from a real browser UA — confirmed
        // via manual curl testing that a browser UA gets a clean 200 where
        // no UA at all is more likely to get blocked/rate-limited.
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 12000,
    });
    return Array.isArray(data) ? data : [];
  } catch (err) {
    console.error("❌ [pump.fun poll] fetchNewestCoins error:", err.message);
    return [];
  }
}

async function fetchCoinDetail(mintAddress) {
  try {
    const { data } = await axios.get(`https://frontend-api-v3.pump.fun/coins/${mintAddress}`, {
      headers: {
        Origin: "https://pump.fun",
        Referer: "https://pump.fun/",
        Accept: "application/json",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      },
      timeout: 10000,
    });
    return data ?? null;
  } catch (err) {
    console.error(`❌ [pump.fun poll] fetchCoinDetail(${mintAddress}) error:`, err.message);
    return null;
  }
}

/** Normalize a raw pump.fun API coin object into the same shape as a
 * PumpPortal websocket "create" event, so downstream code (monitor.js)
 * doesn't need to know which source a new token came from. Returns null
 * for tokens that shouldn't be surfaced (already migrated off the
 * bonding curve, or banned).
 *
 * IMPORTANT: this REST API returns virtual_sol_reserves/virtual_token_reserves
 * in RAW base units (lamports, and raw token units at pump.fun's standard
 * 6 decimals) — confirmed by manual testing. They're converted to
 * human-readable SOL/tokens here to match the units the code assumes
 * elsewhere (see priceSolPerToken in pumpfun_feed.js). If pump.fun ever
 * changes token decimals for a specific mint this will be slightly off;
 * it's only used for informational display, never for trade sizing. */
const LAMPORTS_PER_SOL = 1e9;
const PUMPFUN_TOKEN_DECIMALS = 6;

function toCreateEvent(raw) {
  const mint = raw.mint ?? raw.address;
  if (!mint) return null;
  if (raw.complete) return null; // already graduated off pump.fun's bonding curve
  if (raw.is_banned) return null;
  return {
    txType: "create",
    mint,
    name: raw.name ?? "Unknown",
    symbol: raw.symbol ?? "UNKNOWN",
    usdMarketCap: parseFloat(raw.usd_market_cap) || 0,
    vSolInBondingCurve: raw.virtual_sol_reserves ? raw.virtual_sol_reserves / LAMPORTS_PER_SOL : undefined,
    vTokensInBondingCurve: raw.virtual_token_reserves
      ? raw.virtual_token_reserves / 10 ** PUMPFUN_TOKEN_DECIMALS
      : undefined,
    source: "poll",
  };
}

/**
 * Real trade volume, broken into 5m/1h/6h/24h buckets — confirmed via a
 * live DevTools capture against https://pump.fun/coin/<mint>. This is the
 * ACTUAL volume source. The /coins list and /coins/:mint detail endpoints
 * above have NO volume field anywhere in their response — none of
 * "volume", "volumeUsd", etc. exist on them, only market cap and reserves.
 * Needs no API key, unlike PumpPortal's metered subscribeTokenTrade.
 */
const SOLANA_CHAIN_ID = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function fetchMarketActivity(mintAddress) {
  try {
    const { data } = await axios.get(
      `https://swap-api.pump.fun/v1/coins/${mintAddress}/market-activity`,
      {
        params: { program: "pump", chainId: SOLANA_CHAIN_ID },
        headers: {
          Origin: "https://pump.fun",
          Referer: "https://pump.fun/",
          Accept: "application/json",
          "User-Agent": BROWSER_UA,
        },
        timeout: 10000,
      }
    );
    return data ?? null;
  } catch (err) {
    console.error(`❌ [pump.fun poll] fetchMarketActivity(${mintAddress}) error:`, err.message);
    return null;
  }
}

/** USD volume for one bucket ('5m' | '1h' | '6h' | '24h') from a
 * market-activity response, or 0 if missing/unavailable. '5m' is the right
 * bucket for a freshly-launched token's discovery window — '24h' on a
 * 10-minute-old token is meaningless, it'd just equal all-time volume.
 * This is TOTAL volume (buys + sells combined) — see buyVolumeUsd() below
 * for buy-side only. */
function bucketVolumeUsd(activity, bucket = "5m") {
  return activity?.[bucket]?.volumeUSD ?? 0;
}

/** Buy-side-only USD volume for one bucket. Checks the field-name variants
 * pump.fun-style APIs commonly use, then falls back to summing a raw
 * trades list if one is present. NOTE: the exact buy-only field name on
 * this endpoint hasn't been confirmed via a live response capture (only
 * total `volumeUSD` was) — if none of these match, it falls back to total
 * volume and prints a one-time console warning so you know to check a live
 * response and add the real field name here. */
function buyVolumeUsd(activity, bucket = "5m") {
  const b = activity?.[bucket];
  if (!b) return 0;
  if (typeof b.buyVolumeUSD === "number") return b.buyVolumeUSD;
  if (typeof b.buyVolumeUsd === "number") return b.buyVolumeUsd;
  if (typeof b.buy_volume_usd === "number") return b.buy_volume_usd;
  if (Array.isArray(b.trades)) {
    return b.trades
      .filter((t) => t.is_buy === true || t.type === "buy" || t.side === "buy")
      .reduce((sum, t) => sum + (Number(t.volumeUSD ?? t.usd ?? t.amountUsd) || 0), 0);
  }
  if (!buyVolumeUsd._warned) {
    buyVolumeUsd._warned = true;
    console.warn(
      "⚠️ [pump.fun] no buy-only volume field recognized on market-activity response — falling back to TOTAL volume (buys+sells). Log a live response and update buyVolumeUsd() in pumpfun_api.js with the real field name."
    );
  }
  return b.volumeUSD ?? 0;
}

/** Live price (SOL per token) from a freshly-polled /coins/:mint detail
 * record — same bonding-curve-reserves math as the websocket path used,
 * just fed by polling instead of a trade event. */
function priceSolFromDetail(raw) {
  const vSol = raw?.virtual_sol_reserves;
  const vTok = raw?.virtual_token_reserves;
  if (!vSol || !vTok) return null;
  return vSol / LAMPORTS_PER_SOL / (vTok / 10 ** PUMPFUN_TOKEN_DECIMALS);
}

module.exports = {
  fetchNewestCoins,
  fetchCoinDetail,
  toCreateEvent,
  fetchMarketActivity,
  bucketVolumeUsd,
  buyVolumeUsd,
  priceSolFromDetail,
};

