/**
 * Simple JSON-file persistence, one file per Telegram chat. Fine for a
 * personal / few-user bot — swap for SQLite/Postgres if this grows.
 */
const fs = require("fs");
const path = require("path");
const config = require("./config");
const wallet = require("./wallet");

fs.mkdirSync(config.DATA_DIR, { recursive: true });

function filePath(chatId) {
  return path.join(config.DATA_DIR, `${chatId}.json`);
}

// Demo and real each get their own settings + stats, so switching modes
// never mixes a demo take-profit % into a real trade or vice versa.
function defaultModeState() {
  return {
    settings: {
      monitorTimeSec: config.DEFAULT_MONITOR_TIME_SEC,
      volumeThresholdUsd: config.DEFAULT_VOLUME_THRESHOLD_USD,
      buyAmountSol: config.DEFAULT_BUY_AMOUNT_SOL,
      sellPct: config.DEFAULT_SELL_PCT,
    },
    stats: {
      tokensBought: 0,
      multiplierSum: 0,
      pnlUsd: 0,
    },
  };
}

function defaultChat(chatId) {
  return {
    chatId,
    wallet: wallet.generateWallet(),
    dashboardMessageId: null,
    view: "main", // "main" | "log" | "positions" | "awaiting"
    awaiting: null, // settings field currently being typed in, if any
    demoMode: true,
    running: false,
    demoBalanceUsd: config.DEMO_START_BALANCE_USD,
    demo: defaultModeState(),
    real: defaultModeState(),
    positions: [], // open positions currently held / being watched for take-profit, each tagged mode: "DEMO"|"REAL"
    tradeLog: [], // most recent last
  };
}

/** The settings + stats object for whichever mode (demo/real) is active. */
function activeState(chat) {
  return chat.demoMode ? chat.demo : chat.real;
}

function chatExists(chatId) {
  return fs.existsSync(filePath(chatId));
}

/** All chatIds with a saved state file — used on process boot to resume
 * any chat that was left "running" before a restart. */
function listChatIds() {
  return fs
    .readdirSync(config.DATA_DIR)
    .filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"))
    .map((f) => f.replace(/\.json$/, ""));
}

function getChat(chatId) {
  const p = filePath(chatId);
  if (!fs.existsSync(p)) {
    const chat = defaultChat(chatId);
    saveChat(chat);
    return chat;
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveChat(chat) {
  const p = filePath(chat.chatId);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(chat, null, 2));
  fs.renameSync(tmp, p);
}

function addTradeLog(chat, entry) {
  chat.tradeLog.push(entry);
  if (chat.tradeLog.length > 200) chat.tradeLog = chat.tradeLog.slice(-200);
}

module.exports = { getChat, saveChat, chatExists, addTradeLog, activeState, listChatIds };
