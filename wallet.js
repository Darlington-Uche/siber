/**
 * Real Solana keypair generation + encrypted-at-rest storage.
 *
 * Each Telegram chat gets its own hot wallet. Private keys are encrypted
 * with AES-256-GCM using a master key kept outside chat storage
 * (data/.masterkey, or WALLET_MASTER_KEY env var). This is still a hot
 * wallet living on whatever machine runs the bot — fund it only with what
 * you're willing to risk, and don't expose data/ to anyone.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");
const config = require("./config");

const MASTERKEY_FILE = path.join(config.DATA_DIR, ".masterkey");

function loadMasterKey() {
  if (config.WALLET_MASTER_KEY) return Buffer.from(config.WALLET_MASTER_KEY, "hex");
  if (fs.existsSync(MASTERKEY_FILE)) return Buffer.from(fs.readFileSync(MASTERKEY_FILE, "utf8").trim(), "hex");
  const key = crypto.randomBytes(32);
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(MASTERKEY_FILE, key.toString("hex"), { mode: 0o600 });
  return key;
}

const MASTER_KEY = loadMasterKey();

function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", MASTER_KEY, iv);
  const enc = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function decrypt(payloadB64) {
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", MASTER_KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

function generateWallet() {
  const kp = Keypair.generate();
  const privB58 = bs58.encode(kp.secretKey);
  return {
    pubkey: kp.publicKey.toBase58(),
    privkeyEnc: encrypt(privB58),
  };
}

function loadKeypair(walletRecord) {
  const privB58 = decrypt(walletRecord.privkeyEnc);
  return Keypair.fromSecretKey(bs58.decode(privB58));
}

/** Only call in direct response to an explicit user request to see their key. */
function revealPrivateKey(walletRecord) {
  return decrypt(walletRecord.privkeyEnc);
}

module.exports = { generateWallet, loadKeypair, revealPrivateKey };
