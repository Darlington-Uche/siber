# PumpFun Sniper Bot (Telegram, Node.js)

Monitors new pump.fun token launches. For each new token, watches trading
volume for a configurable window (default 10 min). If volume crosses your
threshold, it buys automatically. It then watches price and sells the whole
position the moment it's up your configured take-profit %. Demo mode runs
the identical logic against a virtual $20 balance so you can test the
strategy risk-free before switching to real trading.

## ⚠️ Read this first

- **This trades real money on brand-new, unaudited pump.fun tokens.** The
  overwhelming majority of these are rug pulls, honeypots, or go to zero
  within minutes. A volume spike is not a signal of legitimacy — bots and
  wash trading can fake it. Treat any capital you put in this wallet as
  money you can lose completely.
- **This is not financial advice**, and I'm not a financial advisor. You're
  responsible for your own trading decisions and for complying with the
  laws that apply to you.
- **The private key never leaves your machine**, but it is a hot wallet
  sitting in `data/*.json` (encrypted) on whatever server runs this bot.
  Anyone with shell access to that machine + your master key can drain it.
  Only fund it with what you're prepared to lose, and don't expose `data/`.
- **The PumpPortal API details in `pumpfun_feed.js` and
  `trading_engine.js` (message shapes, field names, endpoints) were written
  from general knowledge, not a live fetch of their current docs.** Check
  https://pumpportal.fun/docs against this code before trusting it with
  real funds, and test extensively in demo mode first.
- Run in **demo mode by default**. Only flip to real mode once you've
  watched it behave correctly for a while.

## Setup

```bash
npm install
cp .env.example .env
# edit .env: set TELEGRAM_BOT_TOKEN (from @BotFather)
node bot.js
```

On `/start`, the bot generates a real Solana wallet for that chat
(encrypted at rest) and shows one dashboard message that it edits in
place from then on — it never spams new messages, and it deletes your
replies to its prompts to keep the chat to a single card.

To fund the wallet for real trading, send SOL to the address shown on the
dashboard. To view the raw private key (e.g. to import into Phantom), send
`/exportkey` — this is the only way to see it, and it's shown once,
deliberately, on request only.

## Dashboard

```
👛 Wallet address
💰 Balance (USD) — demo balance in demo mode, live on-chain balance in real mode
📊 Tokens Bought / Avg Multiplier / PnL / Open Positions
⚙️ Buy Amount / Sell Target % / Monitor Time / Volume Threshold
```

Buttons: **Monitor Time · Volume · Demo Mode toggle · Start/Stop ·
Set Buy · Sell % · Trade Log · Refresh**

Tapping a setting button turns the dashboard into a prompt; whatever you
type next updates that setting and the card reverts to the dashboard.
Demo mode always starts fresh with $20 virtual balance the moment you hit
**START**.

## Discovery: two independent sources

New tokens are detected two ways at once, de-duplicated against one shared
"seen mints" set so a token picked up by both never triggers two watchers:

1. **PumpPortal websocket** (`pumpfun_feed.js`) — real-time push, and also
   the only source used for live trade *volume* and *price* once a token
   is being watched (the poller below has no equivalent trade stream).
2. **Direct polling of pump.fun's own frontend API** (`pumpfun_api.js`) —
   hits `frontend-api-v3.pump.fun/coins` every `POLL_INTERVAL_MS` (default
   15s) as a redundant safety net, in case the websocket schema drifts or
   the connection silently stalls without erroring. **Verified working**
   via manual curl testing (Aug 2026) — a real browser `User-Agent` header
   is required, the default axios UA gets treated differently by
   Cloudflare (which fronts this API). Reserve fields come back as raw
   base units (lamports / 6-decimal token units) and are converted to
   human-readable SOL/tokens in `toCreateEvent()`.
   This is pump.fun's own internal frontend API, not a documented/stable
   public one — it can change again without notice, which is exactly why
   it's a backup and not the primary source.

## How the strategy works (`monitor.js`)

1. **Discovery** — every new pump.fun token (from either source above)
   gets a per-token watcher for up to `Monitor Time` minutes, summing live
   trade volume (USD) from the websocket.
2. **Buy** — if volume crosses `Volume Threshold` inside that window, it
   buys `Buy Amount` SOL worth immediately (real swap or demo fill).
3. **Take-profit** — it then watches live price with no time limit. The
   instant price is up `Sell %` from the buy price, it sells the full
   position and logs the trade with multiplier + PnL.
4. If volume never crosses the threshold inside the window, the token is
   dropped — no trade, no further tracking.

## Files

| File | Purpose |
|---|---|
| `bot.js` | Telegram UI — single edited dashboard message, buttons, prompts |
| `monitor.js` | Discovery + buy + take-profit watch loop per token |
| `pumpfun_feed.js` | Shared PumpPortal websocket (new tokens + trades) |
| `trading_engine.js` | Real (on-chain) and demo buy/sell execution |
| `wallet.js` | Solana keypair generation + AES-256-GCM encrypted storage |
| `storage.js` | Per-chat JSON persistence |
| `config.js` | All tunables / env vars |

## Extending

- Positions currently sell 100% at the take-profit trigger. To support
  partial take-profits or trailing stops, extend the phase-2 loop in
  `monitor.js`.
- Storage is flat JSON files — fine for one or a few users; move to
  SQLite/Postgres if you're running this for many chats at once.
