const crypto = require("node:crypto");
const db = require("./db");
const config = require("./config");

const COOKIE = "ndx_s";

// ---- password hashing (scrypt) ----
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString("base64")}$${hash.toString("base64")}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.startsWith("scrypt$")) return false;
  const [, saltB64, hashB64] = stored.split("$");
  const expected = Buffer.from(hashB64, "base64");
  const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(expected, actual);
}

function getPasswordHash() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'password'").get();
  return row ? row.value : null;
}

function setPassword(password) {
  db.prepare("INSERT INTO settings(key, value) VALUES('password', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(hashPassword(password));
  db.prepare("DELETE FROM sessions").run(); // log out everywhere
}

// ---- sessions ----
const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

function createSession(ip, ua) {
  const token = crypto.randomBytes(32).toString("base64url");
  const now = Date.now();
  db.prepare("INSERT INTO sessions(token_hash, created, expires, ip, ua) VALUES (?, ?, ?, ?, ?)")
    .run(sha256(token), now, now + config.sessionDays * 864e5, ip, (ua || "").slice(0, 200));
  return token;
}

function sessionCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${config.sessionDays * 86400}`;
}
const clearCookie = `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

function readToken(req) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === COOKIE) return v.join("=");
  }
  return null;
}

function isAuthenticated(req) {
  const token = readToken(req);
  if (!token) return false;
  const row = db.prepare("SELECT expires FROM sessions WHERE token_hash = ?").get(sha256(token));
  return !!row && row.expires > Date.now();
}

function destroySession(req) {
  const token = readToken(req);
  if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
}

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires < ?").run(Date.now());
}

// ---- simple in-memory rate limiter ----
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { count: 0, reset: now + windowMs };
  if (now > b.reset) { b.count = 0; b.reset = now + windowMs; }
  b.count++;
  buckets.set(key, b);
  return b.count <= max;
}
// count an event without checking (used for failed logins)
function hit(key, windowMs) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now > b.reset) buckets.set(key, { count: 1, reset: now + windowMs });
  else b.count++;
}
// true when the key already reached its limit in the current window
function isLimited(key, max) {
  const b = buckets.get(key);
  return !!b && Date.now() <= b.reset && b.count >= max;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref();

module.exports = {
  hashPassword, verifyPassword, getPasswordHash, setPassword,
  createSession, sessionCookie, clearCookie, isAuthenticated, destroySession, cleanupSessions,
  rateLimit, hit, isLimited,
};
