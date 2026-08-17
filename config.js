/**
 * Central config. Override via environment variables (.env — see .env.example).
 */
require("dotenv").config();

module.exports = {
  BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  RPC_URL: process.env.RPC_URL || "https://api.mainnet-beta.solana.com",

  // Trading. Local Transaction API (unsigned tx you sign yourself — see
  // trading_engine.js). No API key needed for this.
  PUMPPORTAL_TRADE_LOCAL:
    process.env.PUMPPORTAL_TRADE_LOCAL || "https://pumpportal.fun/api/trade-local",

  // Websocket used ONLY for free subscribeNewToken (a redundant discovery
  // signal alongside the poller below — no api-key needed for this method).
  // NOT used for subscribeTokenTrade anymore — see note on
  // VOLUME_POLL_INTERVAL_MS below for why.
  PUMPPORTAL_WS: process.env.PUMPPORTAL_WS || "wss://pumpportal.fun/api/data",

  // Discovery + volume + price all come from polling pump.fun's own
  // frontend/swap APIs directly (see pumpfun_api.js), NOT from PumpPortal's
  // websocket trade stream. Confirmed live: PumpPortal's subscribeTokenTrade
  // requires an api-key tied to a wallet funded with >= 0.02 SOL (docs:
  // https://pumpportal.fun/data-api/real-time), so it silently returns zero
  // trade events without one — that's why volume/buys never fired before.
  // Polling swap-api.pump.fun's market-activity endpoint needs no key at all.
  POLL_INTERVAL_MS: parseInt(process.env.POLL_INTERVAL_MS || "15000", 10),
  // How often each actively-watched mint is polled for volume (discovery
  // phase) and price (both phases). Shorter = more responsive to a fast
  // volume threshold, at the cost of more requests per watched token.
  VOLUME_POLL_INTERVAL_MS: parseInt(process.env.VOLUME_POLL_INTERVAL_MS || "8000", 10),
  COINS_PER_PAGE: parseInt(process.env.COINS_PER_PAGE || "30", 10),
  SEEN_MINTS_CAP: 5000,

  // Wallet encryption at rest. Generate one with:
  //   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  // If unset, a key is auto-generated on first run into data/.masterkey
  // (fine for personal/local use, NOT for shared hosting).
  WALLET_MASTER_KEY: process.env.WALLET_MASTER_KEY || "",

  DEMO_START_BALANCE_USD: 20,
  DEFAULT_MONITOR_TIME_SEC: 300, // 5 min — how often a discovery round (fetch + scan new tokens) runs
  DISCOVERY_TOKEN_GAP_MS: 2000, // per-token budget during a scan: one volume check, then move on, never re-check
  MIN_BALANCE_USD: 5, // below this, pause discovery entirely (both demo & real) until balance recovers via a sell
  DEFAULT_VOLUME_THRESHOLD_USD: 5000,
  DEFAULT_BUY_AMOUNT_SOL: 0.05,
  DEFAULT_SELL_PCT: 50, // take-profit trigger: sell at +50% (1.5x)
  SLIPPAGE_PCT: 15,
  PRIORITY_FEE_SOL: 0.0005,

  DATA_DIR: require("path").join(__dirname, "data"),
};
