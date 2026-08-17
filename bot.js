/**
 * Telegram bot UI. Everything lives in ONE message per chat that gets
 * edited in place (never re-sent), plus stray user replies to prompts get
 * deleted immediately after being processed so the chat stays clean.
 */
const { Telegraf, Markup } = require("telegraf");
const config = require("./config");
const storage = require("./storage");
const walletMod = require("./wallet");
const trading = require("./trading_engine");
const pumpfunApi = require("./pumpfun_api");
const monitor = require("./monitor");

if (!config.BOT_TOKEN) {
  console.error("Set TELEGRAM_BOT_TOKEN (see .env.example). Exiting.");
  process.exit(1);
}

const bot = new Telegraf(config.BOT_TOKEN);

// ---------------------------------------------------------------------
// Dashboard rendering
// ---------------------------------------------------------------------

function fmtUsd(n) {
  return `$${(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function renderMain(chat) {
  const solInfo = await trading.getWalletBalanceUsd(chat.wallet.pubkey);
  const balanceUsd = chat.demoMode ? chat.demoBalanceUsd : solInfo.usd;
  const active = storage.activeState(chat); // demo or real settings+stats, whichever mode is on
  const avgMult = active.stats.tokensBought > 0 ? active.stats.multiplierSum / active.stats.tokensBought : 0;
  const s = active.settings;
  const openCount = chat.positions.filter((p) => p.mode === (chat.demoMode ? "DEMO" : "REAL")).length;

  const text = [
    `🤖 *PumpFun Sniper Bot*`,
    ``,
    `👛 Wallet: \`${chat.wallet.pubkey}\``,
    `💰 Balance: *${fmtUsd(balanceUsd)}* ${chat.demoMode ? "(demo)" : "(real, on-chain)"}`,
    `🎮 Mode: ${chat.demoMode ? "🟣 DEMO" : "🔴 REAL"}`,
    `⚡ Status: ${chat.running ? "🟢 Running" : "⚪ Stopped"}`,
    ``,
    `📊 *Stats* (${chat.demoMode ? "demo" : "real"})`,
    `Tokens Bought: ${active.stats.tokensBought}`,
    `Avg Multiplier: ${avgMult.toFixed(2)}x`,
    `PnL: ${active.stats.pnlUsd >= 0 ? "+" : ""}${fmtUsd(active.stats.pnlUsd)}`,
    `Open Positions: ${openCount}`,
    ``,
    `⚙️ *Settings* (${chat.demoMode ? "demo" : "real"})`,
    `Buy Amount: ${s.buyAmountSol} SOL`,
    `Sell Target: +${s.sellPct}% (${(1 + s.sellPct / 100).toFixed(2)}x)`,
    `Scan Interval: ${Math.round(s.monitorTimeSec / 60)} min`,
    `Volume Threshold: ${fmtUsd(s.volumeThresholdUsd)}`,
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⏱ Scan Interval", "set:monitorTimeSec"), Markup.button.callback("💵 Volume", "set:volumeThresholdUsd")],
    [Markup.button.callback(chat.demoMode ? "🎮 Demo Mode: ON" : "🎮 Demo Mode: OFF", "toggle:demoMode"), Markup.button.callback(chat.running ? "⏹ STOP" : "▶️ START", "toggle:running")],
    [Markup.button.callback("💰 Set Buy", "set:buyAmountSol"), Markup.button.callback("📉 Sell %", "set:sellPct")],
    [Markup.button.callback("📈 Positions", "view:positions"), Markup.button.callback("📜 Trade Log", "view:log")],
    [Markup.button.callback("🔄 Refresh", "view:main")],
  ]);

  return { text, kb };
}

// Open positions for the active mode, as a real portfolio read-out: total
// value + total unrealized PnL up top, then each position's current $
// value and PnL, sorted best-performer first. The auto-sell logic itself
// lives in monitor.js's holding watch and runs regardless of this view.
async function renderPositions(chat) {
  const mode = chat.demoMode ? "DEMO" : "REAL";
  const open = chat.positions.filter((p) => p.mode === mode);
  const solPrice = await trading.getSolPrice();

  let totalCostUsd = 0;
  let totalValueUsd = 0;

  const rows = await Promise.all(
    open.map(async (p) => {
      const costUsd = p.buyAmountSol * solPrice;
      totalCostUsd += costUsd;
      const heldMin = Math.max(0, Math.round((Date.now() - p.buyTime) / 60000));

      const detail = await pumpfunApi.fetchCoinDetail(p.mint);
      const priceSol = detail ? pumpfunApi.priceSolFromDetail(detail) : null;
      if (!priceSol) {
        totalValueUsd += costUsd; // best guess while price is temporarily unavailable
        return { pnlUsd: 0, line: `🔸 *${p.symbol}* · \`${short(p.mint)}\` · price unavailable · ${heldMin}m held` };
      }

      const mult = priceSol / p.buyPriceSol;
      const valueUsd = costUsd * mult;
      totalValueUsd += valueUsd;
      const pnlUsd = valueUsd - costUsd;
      const emoji = mult >= 1 ? "🟢" : "🔴";
      const line = [
        `${emoji} *${p.symbol}* · ${mult.toFixed(2)}x · ${fmtUsd(valueUsd)} (${pnlUsd >= 0 ? "+" : ""}${fmtUsd(pnlUsd)})`,
        `\`${short(p.mint)}\` · ${p.buyAmountSol} SOL in · ${heldMin}m held`,
      ].join("\n");
      return { pnlUsd, line };
    })
  );
  rows.sort((a, b) => b.pnlUsd - a.pnlUsd);

  const totalPnl = totalValueUsd - totalCostUsd;
  const text = [
    `📈 *Portfolio* (${chat.demoMode ? "demo" : "real"}) — ${open.length} open`,
    `Value: *${fmtUsd(totalValueUsd)}* · Unrealized PnL: ${totalPnl >= 0 ? "+" : ""}${fmtUsd(totalPnl)}`,
    ``,
    rows.length ? rows.map((r) => r.line).join("\n\n") : "_No open positions. Bought tokens show up here and are auto-sold at your take-profit target._",
  ].join("\n");

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Refresh", "view:positions")],
    [Markup.button.callback("⬅ Back", "view:main")],
  ]);
  return { text, kb };
}

function renderLog(chat) {
  const last = chat.tradeLog.slice(-10).reverse();
  const lines = last.map((t) => {
    const time = new Date(t.ts).toLocaleTimeString();
    if (t.type === "BUY") return `🟢 ${time} BUY ${t.symbol} · ${t.amountSol} SOL · ${t.mode} · \`${short(t.tx)}\``;
    if (t.type === "SELL") return `🔴 ${time} SELL ${t.symbol} · ${t.multiplier.toFixed(2)}x · PnL ${t.pnlUsd >= 0 ? "+" : ""}${fmtUsd(t.pnlUsd)} · ${t.mode} · \`${short(t.tx)}\``;
    if (t.type === "BUY_FAILED") return `⚠️ ${time} BUY FAILED ${t.symbol} · ${t.error}`;
    if (t.type === "SELL_FAILED") return `⚠️ ${time} SELL FAILED ${t.symbol} · ${t.error}`;
    return `${time} ${t.type}`;
  });
  const text = [`📜 *Trade Log* (last ${last.length})`, ``, lines.length ? lines.join("\n") : "_No trades yet._"].join("\n");
  const kb = Markup.inlineKeyboard([[Markup.button.callback("⬅ Back", "view:main")]]);
  return { text, kb };
}

function short(tx) {
  if (!tx) return "";
  return tx === "DEMO" ? "DEMO" : tx.slice(0, 8) + "...";
}

function renderPrompt(field) {
  const labels = {
    monitorTimeSec: "⏱ Send new *scan interval* in minutes — how often to fetch and check new tokens (e.g. 5).",
    volumeThresholdUsd: "💵 Send new *volume threshold* in USD (e.g. 5000).",
    buyAmountSol: "💰 Send new *buy amount* in SOL (e.g. 0.05).",
    sellPct: "📉 Send new *take-profit %* — sell when price is up this much (e.g. 50 = 1.5x).",
  };
  const kb = Markup.inlineKeyboard([[Markup.button.callback("✖ Cancel", "view:main")]]);
  return { text: labels[field], kb };
}

async function renderView(chat) {
  if (chat.view === "log") return renderLog(chat);
  if (chat.view === "positions") return renderPositions(chat);
  if (chat.view === "awaiting") return renderPrompt(chat.awaiting);
  return renderMain(chat);
}

async function pushDashboard(ctx, chat) {
  const view = await renderView(chat);
  const opts = { parse_mode: "Markdown", ...view.kb };
  if (chat.dashboardMessageId) {
    try {
      await ctx.telegram.editMessageText(chat.chatId, chat.dashboardMessageId, undefined, view.text, opts);
      return;
    } catch (e) {
      // message may have been deleted by the user — fall through to resend
    }
  }
  const sent = await ctx.telegram.sendMessage(chat.chatId, view.text, opts);
  chat.dashboardMessageId = sent.message_id;
  storage.saveChat(chat);
}

async function refreshDashboardByChatId(chatId) {
  const chat = storage.getChat(chatId);
  if (!chat.dashboardMessageId) return;
  const view = await renderView(chat);
  const opts = { parse_mode: "Markdown", ...view.kb };
  try {
    await bot.telegram.editMessageText(chat.chatId, chat.dashboardMessageId, undefined, view.text, opts);
  } catch {
    /* ignore transient edit races */
  }
}

// ---------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------

bot.start(async (ctx) => {
  const chat = storage.getChat(ctx.chat.id);
  chat.view = "main";
  storage.saveChat(chat);
  await pushDashboard(ctx, chat);
});

// Reveal private key only on explicit, deliberate command — never shown by default.
bot.command("exportkey", async (ctx) => {
  const chat = storage.getChat(ctx.chat.id);
  const key = walletMod.revealPrivateKey(chat.wallet);
  const warn = await ctx.reply(
    `⚠️ *Your private key* (base58) — anyone with this can drain your wallet. This message will not be repeated.\n\n\`${key}\`\n\nDelete it after saving somewhere safe.`,
    { parse_mode: "Markdown" }
  );
  // Deliberately NOT auto-deleted — user needs time to copy it. They can delete manually.
});

// ---------------------------------------------------------------------
// Callback buttons
// ---------------------------------------------------------------------

bot.on("callback_query", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const chat = storage.getChat(ctx.chat.id);
  await ctx.answerCbQuery();

  if (data === "view:main") {
    chat.view = "main";
    chat.awaiting = null;
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  if (data === "view:log") {
    chat.view = "log";
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  if (data === "view:positions") {
    chat.view = "positions";
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  if (data.startsWith("set:")) {
    const field = data.split(":")[1];
    chat.view = "awaiting";
    chat.awaiting = field;
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  if (data === "toggle:demoMode") {
    chat.demoMode = !chat.demoMode;
    if (chat.demoMode) chat.demoBalanceUsd = config.DEMO_START_BALANCE_USD;
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  if (data === "toggle:running") {
    chat.running = !chat.running;
    if (chat.running && chat.demoMode) {
      chat.demoBalanceUsd = config.DEMO_START_BALANCE_USD; // fresh $20 every start in demo mode
    }
    storage.saveChat(chat);
    monitor.setRunning(chat.chatId, chat.running);
    return pushDashboard(ctx, chat);
  }
});

// ---------------------------------------------------------------------
// Text replies (answers to "set:" prompts)
// ---------------------------------------------------------------------

bot.on("text", async (ctx) => {
  const chat = storage.getChat(ctx.chat.id);
  if (chat.view !== "awaiting" || !chat.awaiting) return; // ignore stray chatter

  const raw = ctx.message.text.trim();
  const num = parseFloat(raw.replace("%", ""));
  const field = chat.awaiting;

  // Always try to delete the user's reply to keep the chat to one message.
  try {
    await ctx.deleteMessage(ctx.message.message_id);
  } catch {
    /* bot may lack delete rights in some contexts; non-fatal */
  }

  if (isNaN(num) || num <= 0) {
    chat.view = "awaiting"; // stay on prompt
    storage.saveChat(chat);
    return pushDashboard(ctx, chat);
  }

  const active = storage.activeState(chat); // writes go to whichever mode (demo/real) is currently on
  if (field === "monitorTimeSec") active.settings.monitorTimeSec = Math.round(num * 60);
  if (field === "volumeThresholdUsd") active.settings.volumeThresholdUsd = num;
  if (field === "buyAmountSol") active.settings.buyAmountSol = num;
  if (field === "sellPct") active.settings.sellPct = num;

  chat.view = "main";
  chat.awaiting = null;
  storage.saveChat(chat);
  return pushDashboard(ctx, chat);
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------

monitor.init(refreshDashboardByChatId, async (chatId, text) => {
  await bot.telegram.sendMessage(chatId, text, { parse_mode: "Markdown" });
});
bot.launch().then(() => console.log("bot running"));

bot.catch((err, ctx) => {
  console.error(JSON.stringify({ event: "bot_error", updateType: ctx.updateType, error: err.message, stack: err.stack }));
});

process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
		
