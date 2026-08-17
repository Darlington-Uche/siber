/**
 * Discovery for pump.fun tokens, from TWO independent sources feeding the
 * same `onNewToken` listeners:
 *
 *  1. PumpPortal websocket, subscribeNewToken only (free, no api-key
 *     needed). subscribeTokenTrade/subscribeAccountTrade are NOT used here
 *     anymore — confirmed live against PumpPortal's docs that those require
 *     an api-key tied to a wallet funded with >= 0.02 SOL
 *     (https://pumpportal.fun/data-api/real-time), so without one they just
 *     silently deliver zero events. Volume and live price now come from
 *     polling swap-api.pump.fun instead (see pumpfun_api.js + monitor.js),
 *     which needs no key at all.
 *
 *  2. Direct polling of pump.fun's own frontend API (pumpfun_api.js), on
 *     an interval — a redundant safety net in case the websocket schema
 *     drifts or the connection silently stalls.
 *
 * Both sources are de-duplicated against one shared `seenMints` set before
 * a "new token" event is ever emitted, so a token discovered by both never
 * spawns two watchers.
 *
 * The websocket auto-reconnects with backoff. subscribeTrades/
 * unsubscribeTrades are kept below for anyone who later adds a
 * PUMPPORTAL_API_KEY and wants the live trade stream back — they're unused
 * by the current monitor.js.
 */
const WebSocket = require("ws");
const EventEmitter = require("events");
const config = require("./config");
const pumpfunApi = require("./pumpfun_api");

class PumpPortalFeed extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.tradeListeners = new Map(); // mint -> Set<fn>
    this.newTokenListeners = new Set();
    this.seenMints = new Set(); // shared dedupe across websocket + poller
    this._stopped = false;
    this._backoff = 2000;
    this._pollTimer = null;
  }

  start() {
    this._stopped = false;
    this._connect();
    this._startPolling();
  }

  stop() {
    this._stopped = true;
    if (this.ws) this.ws.close();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _startPolling() {
    const tick = () => this._pollOnce().catch((e) => console.error("poll tick error", e.message));
    tick(); // don't wait a full interval for the first check
    this._pollTimer = setInterval(tick, config.POLL_INTERVAL_MS);
  }

  async _pollOnce() {
    const coins = await pumpfunApi.fetchNewestCoins();
    console.log(JSON.stringify({ event: "poll_tick", fetched: coins.length }));
    if (!coins.length) return;
    // De-dupe and mark seen synchronously before any async/event work, so
    // a coin appearing twice in one page (or across overlapping polls)
    // can't slip past the check twice and fire two "new token" events.
    let fresh = 0;
    for (const raw of coins) {
      const mint = raw.mint ?? raw.address;
      if (!mint || this.seenMints.has(mint)) continue;
      this.seenMints.add(mint);
      const event = pumpfunApi.toCreateEvent(raw);
      if (event) {
        fresh++;
        this._emitNewToken(event);
      }
    }
    console.log(JSON.stringify({ event: "poll_tick_done", fetched: coins.length, freshNew: fresh, seenMints: this.seenMints.size }));
    this._trimSeenMints();
  }

  _trimSeenMints() {
    if (this.seenMints.size <= config.SEEN_MINTS_CAP) return;
    const arr = [...this.seenMints];
    arr.slice(0, arr.length - config.SEEN_MINTS_CAP).forEach((m) => this.seenMints.delete(m));
  }

  _emitNewToken(event) {
    for (const cb of this.newTokenListeners) {
      try {
        cb(event);
      } catch (e) {
        console.error("new_token listener error", e);
      }
    }
  }

  _connect() {
    const ws = new WebSocket(config.PUMPPORTAL_WS);
    this.ws = ws;

    ws.on("open", () => {
      this._backoff = 2000;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      for (const mint of this.tradeListeners.keys()) {
        ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
      }
      console.log(JSON.stringify({ event: "feed_connected" }));
    });

    ws.on("message", (raw) => this._dispatch(raw));

    ws.on("close", () => {
      if (this._stopped) return;
      console.log(JSON.stringify({ event: "feed_disconnected", retryInMs: this._backoff }));
      setTimeout(() => this._connect(), this._backoff);
      this._backoff = Math.min(this._backoff * 2, 30000);
    });

    ws.on("error", () => {
      /* 'close' fires after 'error'; reconnect handled there */
    });
  }

  _dispatch(raw) {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return;
    }
    const txType = data.txType;
    const mint = data.mint;

    if (process.env.DEBUG === "1") {
      console.log(JSON.stringify({ event: "ws_raw", txType, mint, keys: Object.keys(data) }));
    }

    if (txType === "create") {
      if (!mint || this.seenMints.has(mint)) return; // already surfaced by the poller, or a dup on the socket itself
      this.seenMints.add(mint);
      data.source = data.source || "websocket";
      this._emitNewToken(data);
      this._trimSeenMints();
    } else if ((txType === "buy" || txType === "sell") && this.tradeListeners.has(mint)) {
      for (const cb of this.tradeListeners.get(mint)) {
        try {
          cb(data);
        } catch (e) {
          console.error("trade listener error", e);
        }
      }
    }
  }

  onNewToken(cb) {
    this.newTokenListeners.add(cb);
  }

  subscribeTrades(mint, cb) {
    let set = this.tradeListeners.get(mint);
    if (!set) {
      set = new Set();
      this.tradeListeners.set(mint, set);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] }));
      }
    }
    set.add(cb);
  }

  unsubscribeTrades(mint, cb) {
    const set = this.tradeListeners.get(mint);
    if (!set) return;
    set.delete(cb);
    if (set.size === 0) {
      this.tradeListeners.delete(mint);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] }));
      }
    }
  }
}

/** Live price (SOL per token) derived from a trade event's bonding-curve reserves. */
function priceSolPerToken(tradeEvent) {
  const vSol = tradeEvent.vSolInBondingCurve;
  const vTok = tradeEvent.vTokensInBondingCurve;
  if (vSol && vTok) return vSol / vTok;
  return null;
}

module.exports = { PumpPortalFeed, priceSolPerToken };
