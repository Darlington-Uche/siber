/**
 * Real trades: builds an unsigned tx via PumpPortal's "trade-local" endpoint
 * (non-custodial — they hand you bytes to sign yourself), signs locally
 * with the chat's own keypair, and submits it directly to your RPC. Same
 * non-custodial pattern as the Jupiter flow in the reference script, just
 * pointed at pump.fun's bonding-curve trade builder instead of Jupiter
 * (Jupiter generally has no route until a pump.fun token migrates/graduates).
 *
 * Demo trades: no network signing at all — just moves a virtual USD balance
 * using the same live price feed, so the whole flow (discovery, volume
 * threshold, take-profit) behaves identically to real mode.
 */
const { VersionedTransaction, Connection } = require("@solana/web3.js");
const config = require("./config");

const connection = new Connection(config.RPC_URL, "confirmed");

let _solPriceCache = { v: 0, t: 0 };
async function getSolPrice() {
  if (Date.now() - _solPriceCache.t < 20000) return _solPriceCache.v;
  try {
    const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
    const price = parseFloat((await res.json()).price) || 0;
    _solPriceCache = { v: price, t: Date.now() };
    return price;
  } catch {
    return _solPriceCache.v || 0;
  }
}

async function getWalletBalanceUsd(pubkeyStr) {
  const { PublicKey } = require("@solana/web3.js");
  const [lamports, solPrice] = await Promise.all([
    connection.getBalance(new PublicKey(pubkeyStr)),
    getSolPrice(),
  ]);
  const sol = lamports / 1e9;
  return { sol, usd: sol * solPrice };
}

/** Build + sign + send a pump.fun bonding-curve trade via PumpPortal trade-local. */
async function realTrade(keypair, mint, action, amount, denominatedInSol) {
  const body = {
    publicKey: keypair.publicKey.toBase58(),
    action, // "buy" | "sell"
    mint,
    amount, // number (SOL or tokens) or a string like "100%" for sell
    denominatedInSol: denominatedInSol ? "true" : "false",
    slippage: config.SLIPPAGE_PCT,
    priorityFee: config.PRIORITY_FEE_SOL,
    pool: "pump",
  };
  const res = await fetch(config.PUMPPORTAL_TRADE_LOCAL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`trade-local failed: ${res.status} ${await res.text()}`);
  }
  const rawTx = Buffer.from(await res.arrayBuffer());
  const tx = VersionedTransaction.deserialize(rawTx);
  tx.sign([keypair]);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

/**
 * Buy `solAmount` SOL worth of `mint`. In demo mode, spends from the chat's
 * virtual balance instead of sending a real transaction.
 */
async function buy({ chat, mint, keypair, solAmount, priceSol }) {
  if (chat.demoMode) {
    const solPrice = await getSolPrice();
    const costUsd = solAmount * solPrice;
    if (chat.demoBalanceUsd < costUsd) {
      return { ok: false, error: "Insufficient demo balance" };
    }
    chat.demoBalanceUsd -= costUsd;
    return { ok: true, tx: "DEMO", priceSol, solAmount };
  }
  try {
    const sig = await realTrade(keypair, mint, "buy", solAmount, true);
    return { ok: true, tx: sig, priceSol, solAmount };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Sell `percent` of the position in `mint`. In demo mode, credits the
 * virtual balance based on live price movement vs. the recorded buy price.
 */
/**
 * Sell `percent` of the position in `mint`. `demoMode` should reflect the
 * position's OWN mode (position.mode === "DEMO"), not necessarily the
 * chat's current mode — someone can flip Demo/Real after buying, and the
 * sell must still settle the way the position was actually bought.
 */
async function sell({ chat, position, keypair, percent, priceSol, demoMode }) {
  const isDemo = demoMode !== undefined ? demoMode : chat.demoMode;
  if (isDemo) {
    const solPrice = await getSolPrice();
    const multiplier = priceSol / position.buyPriceSol;
    const proceedsUsd = position.buyAmountSol * solPrice * multiplier * (percent / 100);
    chat.demoBalanceUsd += proceedsUsd;
    return { ok: true, tx: "DEMO", priceSol, proceedsUsd, multiplier };
  }
  try {
    const sig = await realTrade(keypair, position.mint, "sell", `${percent}%`, false);
    const solPrice = await getSolPrice();
    const multiplier = priceSol / position.buyPriceSol;
    const proceedsUsd = position.buyAmountSol * solPrice * multiplier * (percent / 100);
    return { ok: true, tx: sig, priceSol, proceedsUsd, multiplier };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

module.exports = { getSolPrice, getWalletBalanceUsd, buy, sell };
