// Two-factor authentication (TOTP, RFC 6238) using only node:crypto.
// Compatible with Google Authenticator, Authy, Microsoft Authenticator, 1Password, etc.
const crypto = require("node:crypto");
const db = require("./db");

const STEP = 30;         // seconds per code
const DIGITS = 6;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ---------- settings helpers ----------
const getSetting = key => db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? null;
const setSetting = (key, value) =>
  db.prepare("INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
const delSetting = key => db.prepare("DELETE FROM settings WHERE key = ?").run(key);

// ---------- base32 ----------
function base32Encode(buf) {
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  let bits = 0, value = 0; const out = [];
  for (const ch of str.replace(/=+$/, "").toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// ---------- TOTP ----------
function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = h.readUInt32BE(o) & 0x7fffffff;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, "0");
}

// returns the matching time-step counter, or null. Accepts ±1 step for clock drift; rejects reused codes.
function checkCode(secretB32, code, lastUsed = -1) {
  if (!/^\d{6}$/.test(code || "")) return null;
  const secret = base32Decode(secretB32);
  const now = Math.floor(Date.now() / 1000 / STEP);
  for (const w of [0, -1, 1]) {
    const counter = now + w;
    if (counter <= lastUsed) continue;
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, counter)), Buffer.from(code))) return counter;
  }
  return null;
}

// ---------- recovery codes ----------
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");
const normRecovery = s => String(s || "").toLowerCase().replace(/[^a-f0-9]/g, "");
function newRecoveryCodes() {
  const codes = Array.from({ length: 8 }, () => {
    const h = crypto.randomBytes(5).toString("hex");
    return `${h.slice(0, 5)}-${h.slice(5)}`;
  });
  setSetting("totp_recovery", JSON.stringify(codes.map(c => sha256(normRecovery(c)))));
  return codes;
}
function useRecoveryCode(input) {
  const n = normRecovery(input);
  if (n.length !== 10) return false;
  const hashes = JSON.parse(getSetting("totp_recovery") || "[]");
  const i = hashes.indexOf(sha256(n));
  if (i < 0) return false;
  hashes.splice(i, 1); // single use
  setSetting("totp_recovery", JSON.stringify(hashes));
  return true;
}

// ---------- public API ----------
const isEnabled = () => !!getSetting("totp_secret");
const recoveryLeft = () => JSON.parse(getSetting("totp_recovery") || "[]").length;

function startSetup(label, issuer) {
  const secret = base32Encode(crypto.randomBytes(20));
  setSetting("totp_pending", secret);
  const uri = `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP}`;
  return { secret, uri };
}

function confirmSetup(code) {
  const pending = getSetting("totp_pending");
  if (!pending) return null;
  const counter = checkCode(pending, code);
  if (counter === null) return null;
  setSetting("totp_secret", pending);
  setSetting("totp_last", counter);
  delSetting("totp_pending");
  return newRecoveryCodes();
}

// verifies a 6-digit code or a recovery code
function verify(input) {
  const secret = getSetting("totp_secret");
  if (!secret) return true;
  const code = String(input || "").trim().replace(/\s/g, "");
  const counter = checkCode(secret, code, Number(getSetting("totp_last") ?? -1));
  if (counter !== null) { setSetting("totp_last", counter); return true; }
  return useRecoveryCode(code);
}

function disable() {
  for (const k of ["totp_secret", "totp_pending", "totp_last", "totp_recovery"]) delSetting(k);
}

module.exports = { isEnabled, recoveryLeft, startSetup, confirmSetup, verify, disable };
