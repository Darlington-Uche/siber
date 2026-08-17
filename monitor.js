/**
 * Monitoring engine.
 *
 * DISCOVERY is now a controlled, sequential scan instead of a websocket-
 * driven flood. Every settings.monitorTimeSec (default 5 min) it fetches
 * ONE batch of newest pump.fun tokens, then walks through them one at a
 * time: a single volume check per token, then a DISCOVERY_TOKEN_GAP_MS
 * (2s) pause before the next one. A token that doesn't clear the volume
 * threshold on its turn is marked seen and never checked again. This caps
 * concurrent pump.fun API calls at ~1 at a time — the old design spawned
 * an independent polling loop per newly-discovered token that ran for up
 * to 10 minutes, so dozens could be hammering the API simultaneously,
 * which is what was tripping rate limits.
 *
 * BALANCE GATE: before each discovery round (and again after every buy),
 * if the active mode's balance (demo virtual balance or real on-chain SOL
 * balance) is below config.MIN_BALANCE_USD, discovery is skipped/paused —
 * no fetch, no scan — until a sell brings it back up. Applies identically
 * to demo and real. Holding watches are never affected by this gate.
 *
 * HOLDING / TAKE-PROFIT watches are fully decoupled from discovery pacing:
 * each open position gets its own continuous poll loop that only stops
 * when the position is sold or explicitly cancelled — it no longer dies
 * just because "running" was toggled off, and resumeHoldingWatches()
 * re-attaches a watch for any open position missing one (e.g. after a
 * process restart, when in-memory watch tasks are gone but positions are
 * still on disk). That combination is what was letting a token sit past
 * its take-profit target with nothing watching it.
 */
const pumpfunApi = require("./pumpfun_api");
const config = require("./config");
const storage = require("./storage");
const wallet = require("./wallet");
const trading = require("./trading_engine");

const activeChats = new Set(); // chatIds currently "running" (gates new discovery, not existing holds)
const discoveryTimers = new Map(); // chatId -> setTimeout handle for the next discovery round
const discoverySeenMints = new Map(); // chatId -> Set<mint> already scanned this session, never re-checked
const watchTasks = new Map(); // `${chatId}:${mint}` -> { cancel() } — holding-phase watches
let dashboardRefreshCb = null; // set by bot.js: async (chatId) => void
let notifyCb = null; // set by bot.js: async (chatId, text) => void — sends a fresh Telegram message, separate from the single edited dashboard

function init(refreshCb, notify) {
  dashboardRefreshCb = refreshCb;
  notifyCb = notify;
  // Resume anything that was left running before a process restart —
  // both the discovery loop and, more importantly, any watch on a
  // position that's already been bought and is waiting to hit target.
  let resumed = 0;
  for (const chatId of storage.listChatIds()) {
    const chat = storage.getChat(chatId);
    resumeHoldingWatches(chatId);
    if (chat.running) {
      setRunning(chatId, true);
      resumed++;
    }
  }
  console.log(JSON.stringify({ event: "monitor_init", resumedRunningChats: resumed }));
}

function setRunning(chatId, running) {
  if (running) {
    activeChats.add(chatId);
    if (!discoverySeenMints.has(chatId)) discoverySeenMints.set(chatId, new Set());
    resumeHoldingWatches(chatId);
    scheduleDiscovery(chatId, 0); // first round fires immediately, then every interval
  } else {
    activeChats.delete(chatId);
    const t = discoveryTimers.get(chatId);
    if (t) clearTimeout(t);
    discoveryTimers.delete(chatId);
    // Deliberately NOT cancelling holding watches here — stopping should
    // stop new buys, not abandon a token you're already holding.
  }
  console.log(JSON.stringify({ event: "set_running", chatId, running, activeChats: [...activeChats] }));
}

function scheduleDiscovery(chatId, delayMs) {
  const t = setTimeout(
    () => runDiscoveryRound(chatId).catch((e) => console.log(JSON.stringify({ event: "discovery_error", chatId, error: e.message }))),
    delayMs
  );
  discoveryTimers.set(chatId, t);
}

async function currentBalanceUsd(chat) {
  if (chat.demoMode) return chat.demoBalanceUsd;
  const info = await trading.getWalletBalanceUsd(chat.wallet.pubkey);
  return info.usd;
}

async function runDiscoveryRound(chatId) {
  if (!activeChats.has(chatId)) return; // stopped while this round was waiting to fire

  const chat = storage.getChat(chatId);
  const intervalMs = (storage.activeState(chat).settings.monitorTimeSec || 300) * 1000;

  const balance = await currentBalanceUsd(chat);
  if (balance < config.MIN_BALANCE_USD) {
    console.log(JSON.stringify({ event: "discovery_skipped_low_balance", chatId, balance: Math.round(balance * 100) / 100 }));
    if (activeChats.has(chatId)) scheduleDiscovery(chatId, intervalMs);
    return; // just keep watching holdings; try discovery again next round
  }

  const seen = discoverySeenMints.get(chatId) || new Set();
  const coins = await pumpfunApi.fetchNewestCoins();
  const fresh = coins.filter((raw) => {
    const mint = raw.mint ?? raw.address;
    return mint && !seen.has(mint);
  });
  console.log(JSON.stringify({ event: "discovery_round", chatId, fetched: coins.length, fresh: fresh.length }));

  for (const raw of fresh) {
    if (!activeChats.has(chatId)) return; // stopped mid-round

    const mint = raw.mint ?? raw.address;
    seen.add(mint); // one look, win or lose — never watched again
    const event = pumpfunApi.toCreateEvent(raw);
    if (event) {
      const bought = await tryBuy(chatId, mint, event.symbol || event.name || "?");
      if (bought) {
        const bal = await currentBalanceUsd(storage.getChat(chatId));
        if (bal < config.MIN_BALANCE_USD) {
          console.log(JSON.stringify({ event: "discovery_paused_low_balance", chatId, balance: Math.round(bal * 100) / 100 }));
          break; // stop scanning this round; holding watches carry on regardless
        }
      }
    }

    await sleep(config.DISCOVERY_TOKEN_GAP_MS);
  }

  trimSeen(seen);
  if (activeChats.has(chatId)) scheduleDiscovery(chatId, intervalMs);
}

function trimSeen(seen) {
  if (seen.size <= config.SEEN_MINTS_CAP) return;
  const arr = [...seen];
  arr.slice(0, arr.length - config.SEEN_MINTS_CAP).forEach((m) => seen.delete(m));
}

/** One volume check + buy attempt for a single token — no repeated polling,
 * it gets one look during its turn. Returns true if a buy went through. */
async function tryBuy(chatId, mint, symbol) {
  const chat = storage.getChat(chatId);
  if (!chat.running) return false;
  const s = storage.activeState(chat).settings;
  const mode = chat.demoMode ? "DEMO" : "REAL";

  const activity = await pumpfunApi.fetchMarketActivity(mint);
  const volumeUsd = pumpfunApi.buyVolumeUsd(activity, "5m"); // buy-side only, not total buy+sell volume
  if (volumeUsd < s.volumeThresholdUsd) return false;

  const detail = await pumpfunApi.fetchCoinDetail(mint);
  const priceSol = detail ? pumpfunApi.priceSolFromDetail(detail) : null;
  if (!priceSol) return false;

  const kp = wallet.loadKeypair(chat.wallet);
  const result = await trading.buy({ chat, mint, keypair: kp, solAmount: s.buyAmountSol, priceSol });

  if (!result.ok) {
    console.log(JSON.stringify({ event: "buy_failed", chatId, mint, error: result.error }));
    storage.addTradeLog(chat, { ts: Date.now(), type: "BUY_FAILED", mint, symbol, error: result.error, mode });
    storage.saveChat(chat);
    return false;
  }

  console.log(JSON.stringify({ event: "buy_success", chatId, mint, symbol, priceSol, tx: result.tx }));
  chat.positions.push({ mint, symbol, buyPriceSol: priceSol, buyAmountSol: s.buyAmountSol, buyTime: Date.now(), mode });
  storage.activeState(chat).stats.tokensBought += 1;
  storage.addTradeLog(chat, { ts: Date.now(), type: "BUY", mint, symbol, amountSol: s.buyAmountSol, priceSol, tx: result.tx, mode });
  storage.saveChat(chat);
  refreshDashboard(chatId);
  notify(
    chatId,
    `🟢 *BUY* · ${symbol} (${mode.toLowerCase()})\n${s.buyAmountSol} SOL @ ${priceSol.toFixed(10)} SOL/token\n\`${short(mint)}\` · tx \`${short(result.tx)}\``
  );

  startHoldingWatch(chatId, mint, symbol, priceSol);
  return true;
}

// ---------------------------------------------------------------------
// Holding / take-profit watch — one persistent loop per open position,
// independent of discovery cadence and of "running" being toggled.
// ---------------------------------------------------------------------

function resumeHoldingWatches(chatId) {
  const chat = storage.getChat(chatId);
  for (const p of chat.positions) {
    const key = `${chatId}:${p.mint}`;
    if (watchTasks.has(key)) continue;
    console.log(JSON.stringify({ event: "resume_holding_watch", chatId, mint: p.mint, symbol: p.symbol }));
    startHoldingWatch(chatId, p.mint, p.symbol, p.buyPriceSol);
  }
}

function startHoldingWatch(chatId, mint, symbol, buyPriceSol) {
  const key = `${chatId}:${mint}`;
  if (watchTasks.has(key)) return;
  let cancelled = false;
  watchTasks.set(key, { cancel: () => (cancelled = true) });
  (async () => {
    try {
      await runHolding(chatId, mint, symbol, buyPriceSol, () => cancelled);
    } catch (e) {
      console.log(JSON.stringify({ event: "watch_error", chatId, mint, error: e.message }));
    } finally {
      watchTasks.delete(key);
    }
  })();
}

const MAX_HOLD_MS = 5 * 60 * 1000; // force-sell any position held this long, regardless of multiplier

async function runHolding(chatId, mint, symbol, buyPriceSol, isCancelled) {
  while (!isCancelled()) {
    const chat = storage.getChat(chatId);
    const position = chat.positions.find((p) => p.mint === mint);
    if (!position) return; // sold elsewhere (e.g. manually) — nothing left to watch

    if (!chat.running) {
      // Paused, not stopped: keep the position watched so it can still
      // hit take-profit while paused, but don't need to spin fast.
      await sleep(config.VOLUME_POLL_INTERVAL_MS);
      continue;
    }

    const s = storage.activeState(chat).settings;

    const detail = await pumpfunApi.fetchCoinDetail(mint);
    const priceSol = detail ? pumpfunApi.priceSolFromDetail(detail) : null;
    if (!priceSol) {
      await sleep(config.VOLUME_POLL_INTERVAL_MS);
      continue;
    }

    const multiplier = priceSol / position.buyPriceSol;
    const targetMultiplier = 1 + s.sellPct / 100;
    const heldMs = Date.now() - position.buyTime;
    const hitTarget = multiplier >= targetMultiplier;
    const timedOut = heldMs >= MAX_HOLD_MS;

    if (hitTarget || timedOut) {
      const reason = hitTarget ? "target" : "timeout_15m";
      const kp = wallet.loadKeypair(chat.wallet);
      const result = await trading.sell({
        chat,
        position,
        keypair: kp,
        percent: 100,
        priceSol,
        demoMode: position.mode === "DEMO", // settle using the mode it was BOUGHT in, not whatever mode is active now
      });

      if (result.ok) {
        chat.positions = chat.positions.filter((p) => p.mint !== mint);
        const stats = (position.mode === "DEMO" ? chat.demo : chat.real).stats;
        stats.multiplierSum += result.multiplier;
        const solPriceNow = await trading.getSolPrice();
        const costUsd = position.buyAmountSol * solPriceNow;
        const pnl = result.proceedsUsd - costUsd;
        stats.pnlUsd += pnl;
        storage.addTradeLog(chat, {
          ts: Date.now(),
          type: "SELL",
          mint,
          symbol,
          priceSol,
          multiplier: result.multiplier,
          pnlUsd: pnl,
          tx: result.tx,
          mode: position.mode,
          reason,
        });
        storage.saveChat(chat);
        await refreshDashboard(chatId);
        const reasonLabel = reason === "target" ? "take-profit" : "15m timeout";
        notify(
          chatId,
          `🔴 *SELL* · ${symbol} (${position.mode.toLowerCase()}) · ${reasonLabel}\n${result.multiplier.toFixed(2)}x · PnL ${pnl >= 0 ? "+" : ""}${fmtUsd(pnl)}\n\`${short(mint)}\` · tx \`${short(result.tx)}\``
        );
      } else {
        console.log(JSON.stringify({ event: "sell_failed", chatId, mint, error: result.error, reason }));
        storage.addTradeLog(chat, { ts: Date.now(), type: "SELL_FAILED", mint, symbol, error: result.error, mode: position.mode });
        storage.saveChat(chat);
      }
      return;
    }

    await sleep(config.VOLUME_POLL_INTERVAL_MS);
  }
}

async function refreshDashboard(chatId) {
  if (dashboardRefreshCb) {
    try {
      await dashboardRefreshCb(chatId);
    } catch (e) {
      console.error("dashboard refresh error", e);
    }
  }
}

function notify(chatId, text) {
  if (!notifyCb) return;
  Promise.resolve(notifyCb(chatId, text)).catch((e) => console.error("notify error", e));
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function short(x) {
  if (!x) return "";
  return x.length <= 10 ? x : `${x.slice(0, 4)}...${x.slice(-4)}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

module.exports = { init, setRunning };

