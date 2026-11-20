const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./src/config");
const db = require("./src/db");
const auth = require("./src/auth");
const mail = require("./src/mail");
const totp = require("./src/totp");
const QRCode = require("qrcode");

const FOLDERS = ["inbox", "sent", "archive", "trash"];
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon",
};
const ADMIN_CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
  "font-src 'self'", "connect-src 'self'", "frame-src 'self'", "object-src 'none'", "base-uri 'none'",
  "form-action 'self'", "frame-ancestors 'none'",
].join("; ");

// ---------- helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== "string" && !Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isJson ? "application/json; charset=utf-8" : "text/plain; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", c => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, "Too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = 64 * 1024) {
  try { return JSON.parse((await readBody(req, limit)).toString("utf8") || "{}"); }
  catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, "Invalid JSON"); }
}

const clientIp = req => (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
const hostOf = req => (req.headers.host || "").split(":")[0].toLowerCase();
const isEmail = s => typeof s === "string" && /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(s) && s.length <= 254;
const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- static files for the admin UI ----------
function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.normalize(path.join(config.publicDir, rel));
  if (!file.startsWith(config.publicDir + path.sep)) return send(res, 404, "Not found");
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, "Not found");
    const ext = path.extname(file);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      // html/js/css: always revalidate so updates show immediately; fonts & images can be cached
      "cache-control": [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=86400",
      "content-security-policy": ADMIN_CSP,
      "x-frame-options": "DENY",
    });
    res.end(data);
  });
}

// ---------- message queries ----------
const LIST_COLS = `m.id, m.folder, m.source, m.mailbox, m.from_name, m.from_addr, m.to_addr, m.subject,
  substr(replace(replace(m.text, char(10), ' '), char(13), ' '), 1, 160) AS snippet,
  m.date, m.read, m.starred, m.has_attach`;

// mailbox: one address to show, or "" for all of them
function listMessages({ folder, q, page, mailbox }) {
  const limit = 50, offset = (Math.max(1, page) - 1) * limit;
  const mb = mailbox ? "AND m.mailbox = :mailbox" : "";
  const params = { limit, offset };
  if (mailbox) params.mailbox = mailbox;
  if (q) {
    params.match = q.split(/\s+/).filter(Boolean).map(w => `"${w.replace(/"/g, "")}"*`).join(" ");
    return db.prepare(`SELECT ${LIST_COLS} FROM messages_fts f JOIN messages m ON m.id = f.rowid
      WHERE messages_fts MATCH :match AND m.folder != 'trash' ${mb} ORDER BY m.date DESC LIMIT :limit OFFSET :offset`).all(params);
  }
  params.folder = folder;
  return db.prepare(`SELECT ${LIST_COLS} FROM messages m WHERE m.folder = :folder ${mb}
    ORDER BY m.date DESC LIMIT :limit OFFSET :offset`).all(params);
}

// unread = inbox unread in total; byMailbox = inbox unread per address
function counts() {
  const out = { inbox: 0, sent: 0, archive: 0, trash: 0, unread: 0, byMailbox: {} };
  for (const r of db.prepare("SELECT folder, COUNT(*) n, SUM(read = 0) u FROM messages GROUP BY folder").all()) {
    out[r.folder] = r.n;
    if (r.folder === "inbox") out.unread = r.u || 0;
  }
  for (const r of db.prepare("SELECT mailbox, SUM(read = 0) u FROM messages WHERE folder = 'inbox' AND mailbox IS NOT NULL GROUP BY mailbox").all()) {
    out.byMailbox[r.mailbox] = r.u || 0;
  }
  return out;
}

// your addresses (can send from them) plus any other address that received mail (catch-all), for the sidebar
function mailboxes() {
  const own = db.prepare("SELECT address, name FROM addresses ORDER BY address = lower(?) DESC, address").all(config.mailFrom);
  const other = db.prepare(`SELECT DISTINCT mailbox AS address FROM messages
    WHERE mailbox IS NOT NULL AND mailbox NOT IN (SELECT address FROM addresses) ORDER BY mailbox`).all();
  return { addresses: own, others: other.map(r => r.address) };
}
const isOwnAddress = a => !!db.prepare("SELECT 1 FROM addresses WHERE address = ?").get(String(a || "").toLowerCase());

function deleteForever(id) {
  db.prepare("DELETE FROM messages WHERE id = ?").run(id);
  fs.rmSync(path.join(config.dataDir, "attachments", String(id)), { recursive: true, force: true });
}

// ---------- routes ----------
async function handleSite(req, res, url) {
  // Public contact form: POST https://nulldex.net/api/contact
  if (url.pathname === "/api/contact" && req.method === "POST") {
    const ip = clientIp(req);
    if (!auth.rateLimit(`form:${ip}`, 5, 60 * 60 * 1000)) throw new HttpError(429, "Too many messages, try later.");
    const b = await readJson(req, 32 * 1024);
    if (b.website) return send(res, 200, { ok: true }); // honeypot: bots fill hidden field
    const name = str(b.name, 120), email = str(b.email, 254), message = str(b.message, 8000);
    if (!name || !isEmail(email) || message.length < 2) throw new HttpError(400, "Please fill in name, a valid email and a message.");
    mail.storeForm({ name, email, message, type: str(b.type, 80), lang: b.lang === "hr" ? "hr" : "en" });
    return send(res, 200, { ok: true });
  }
  throw new HttpError(404, "Not found");
}

async function handleAdmin(req, res, url) {
  const p = url.pathname;

  // Incoming email from the Cloudflare Email Worker (shared secret, no session)
  if (p === "/api/inbound" && req.method === "POST") {
    if (!config.inboundSecret || !safeEqual(req.headers["x-inbound-secret"] || "", config.inboundSecret)) {
      throw new HttpError(401, "Unauthorized");
    }
    const raw = await readBody(req, config.maxInboundBytes);
    const id = await mail.storeInbound(raw, {
      from: str(req.headers["x-envelope-from"], 254), to: str(req.headers["x-envelope-to"], 254),
    });
    return send(res, 200, { ok: true, id });
  }

  if (!p.startsWith("/api/")) return serveStatic(req, res, p);

  // CSRF guard: every state-changing call must carry our custom header
  if (req.method !== "GET" && req.headers["x-nulldex"] !== "1") throw new HttpError(403, "Forbidden");

  // tells the login screen whether to show the 2FA code field
  if (p === "/api/login-info" && req.method === "GET") return send(res, 200, { twoFactor: totp.isEnabled() });

  if (p === "/api/login" && req.method === "POST") {
    const ip = clientIp(req);
    if (auth.isLimited(`login:${ip}`, 5) || auth.isLimited("login:global", 20)) {
      throw new HttpError(429, "Too many failed attempts. Try again later.");
    }
    const { password, code } = await readJson(req);
    const stored = auth.getPasswordHash();
    if (!stored) throw new HttpError(503, "No password set yet. Run: nulldex-admin set-password");
    const twoFactor = totp.isEnabled();
    const passOk = typeof password === "string" && auth.verifyPassword(password, stored);
    const codeOk = passOk && (!twoFactor || totp.verify(code)); // code is only checked after a correct password
    if (!passOk || !codeOk) {
      // only FAILED attempts count: 5 per IP per 15 min, 20 in total per hour (stops attackers with many IPs)
      auth.hit(`login:${ip}`, 15 * 60 * 1000);
      auth.hit("login:global", 60 * 60 * 1000);
      console.warn(new Date().toISOString(), "failed admin login from", ip);
      // same message either way, so attackers can't tell whether the password was right
      throw new HttpError(401, twoFactor ? "Wrong password or code" : "Wrong password");
    }
    const token = auth.createSession(ip, req.headers["user-agent"]);
    return send(res, 200, { ok: true }, { "set-cookie": auth.sessionCookie(token) });
  }

  if (!auth.isAuthenticated(req)) throw new HttpError(401, "Not logged in");

  if (p === "/api/logout" && req.method === "POST") {
    auth.destroySession(req);
    return send(res, 200, { ok: true }, { "set-cookie": auth.clearCookie });
  }
  if (p === "/api/me" && req.method === "GET") {
    return send(res, 200, {
      ok: true, from: config.mailFrom.toLowerCase(), canSend: !!config.brevoApiKey, ...mailboxes(),
      twoFactor: totp.isEnabled(), recoveryLeft: totp.isEnabled() ? totp.recoveryLeft() : 0,
    });
  }

  // ---- two-factor setup ----
  if (p === "/api/2fa/setup" && req.method === "POST") {
    if (totp.isEnabled()) throw new HttpError(400, "2FA is already enabled");
    const { secret, uri } = totp.startSetup(config.mailFrom, config.mailFromName || "Inbox");
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } });
    return send(res, 200, { secret, qr });
  }
  if (p === "/api/2fa/enable" && req.method === "POST") {
    const { code } = await readJson(req);
    const recovery = totp.confirmSetup(String(code || "").trim());
    if (!recovery) throw new HttpError(400, "That code didn't match. Check the time on your phone and try the newest code.");
    return send(res, 200, { ok: true, recovery });
  }
  if (p === "/api/2fa/disable" && req.method === "POST") {
    const { password, code } = await readJson(req);
    const ip = clientIp(req);
    if (auth.isLimited(`login:${ip}`, 5)) throw new HttpError(429, "Too many failed attempts. Try again later.");
    if (!auth.verifyPassword(String(password || ""), auth.getPasswordHash()) || !totp.verify(code)) {
      auth.hit(`login:${ip}`, 15 * 60 * 1000);
      throw new HttpError(401, "Wrong password or code");
    }
    totp.disable();
    return send(res, 200, { ok: true });
  }
  if (p === "/api/counts" && req.method === "GET") return send(res, 200, counts());

  // change the sender name for one of your addresses
  if (p === "/api/addresses" && req.method === "PATCH") {
    const b = await readJson(req);
    if (!isOwnAddress(b.address)) throw new HttpError(404, "Unknown address");
    db.prepare("UPDATE addresses SET name = ? WHERE address = ?").run(str(b.name, 80) || null, String(b.address).toLowerCase());
    return send(res, 200, { ok: true });
  }

  if (p === "/api/messages" && req.method === "GET") {
    const folder = FOLDERS.includes(url.searchParams.get("folder")) ? url.searchParams.get("folder") : "inbox";
    const q = str(url.searchParams.get("q"), 200);
    const page = Number(url.searchParams.get("page")) || 1;
    const mailbox = str(url.searchParams.get("mailbox"), 254).toLowerCase();
    return send(res, 200, { messages: listMessages({ folder, q, page, mailbox }), counts: counts() });
  }

  if (p === "/api/send" && req.method === "POST") {
    const b = await readJson(req, 256 * 1024);
    const to = str(b.to, 1000), cc = str(b.cc, 1000), subject = str(b.subject, 300), text = str(b.text, 100000);
    const all = [...to.split(","), ...cc.split(",")].map(s => s.trim()).filter(Boolean);
    if (!to || !all.every(isEmail)) throw new HttpError(400, "Check the recipient addresses.");
    if (!subject || !text) throw new HttpError(400, "Subject and message are required.");
    const from = str(b.from, 254).toLowerCase() || config.mailFrom.toLowerCase();
    if (!isOwnAddress(from)) throw new HttpError(400, "You can only send from your own addresses.");
    const id = await mail.sendMail({ from, to, cc, subject, text, inReplyTo: str(b.inReplyTo, 500) || null });
    return send(res, 200, { ok: true, id });
  }

  if (p === "/api/password" && req.method === "POST") {
    const { current, next } = await readJson(req);
    if (!auth.verifyPassword(String(current || ""), auth.getPasswordHash())) throw new HttpError(401, "Current password is wrong");
    if (typeof next !== "string" || next.length < 12) throw new HttpError(400, "New password needs at least 12 characters");
    auth.setPassword(next);
    return send(res, 200, { ok: true }, { "set-cookie": auth.clearCookie });
  }

  let m;
  if ((m = p.match(/^\/api\/messages\/(\d+)$/))) {
    const id = Number(m[1]);
    const msg = db.prepare("SELECT * FROM messages WHERE id = ?").get(id);
    if (!msg) throw new HttpError(404, "Not found");

    if (req.method === "GET") {
      if (!msg.read) { db.prepare("UPDATE messages SET read = 1 WHERE id = ?").run(id); msg.read = 1; }
      msg.attachments = db.prepare("SELECT id, filename, content_type, size FROM attachments WHERE message_id = ?").all(id);
      delete msg.meta;
      return send(res, 200, msg);
    }
    if (req.method === "PATCH") {
      const b = await readJson(req);
      if (typeof b.read === "boolean") db.prepare("UPDATE messages SET read = ? WHERE id = ?").run(b.read ? 1 : 0, id);
      if (typeof b.starred === "boolean") db.prepare("UPDATE messages SET starred = ? WHERE id = ?").run(b.starred ? 1 : 0, id);
      if (FOLDERS.includes(b.folder)) db.prepare("UPDATE messages SET folder = ? WHERE id = ?").run(b.folder, id);
      return send(res, 200, { ok: true });
    }
    if (req.method === "DELETE") {
      if (msg.folder === "trash") deleteForever(id);
      else db.prepare("UPDATE messages SET folder = 'trash' WHERE id = ?").run(id);
      return send(res, 200, { ok: true });
    }
  }

  if ((m = p.match(/^\/api\/attachments\/(\d+)$/)) && req.method === "GET") {
    const a = db.prepare("SELECT * FROM attachments WHERE id = ?").get(Number(m[1]));
    if (!a || !fs.existsSync(a.path)) throw new HttpError(404, "Not found");
    const name = encodeURIComponent(a.filename || "attachment");
    res.writeHead(200, {
      "content-type": "application/octet-stream", // never render attachments inline
      "content-disposition": `attachment; filename*=UTF-8''${name}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    return fs.createReadStream(a.path).pipe(res);
  }

  if (p === "/api/trash/empty" && req.method === "POST") {
    for (const r of db.prepare("SELECT id FROM messages WHERE folder = 'trash'").all()) deleteForever(r.id);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, "Not found");
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    const host = hostOf(req);
    if (host === config.adminHost) await handleAdmin(req, res, url);
    else if (config.siteHosts.includes(host)) await handleSite(req, res, url);
    else throw new HttpError(404, "Not found");
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(new Date().toISOString(), req.method, url.pathname, err);
    if (!res.headersSent) send(res, status, { error: status >= 500 && !err.status ? "Server error" : err.message });
    else res.end();
  }
});

// the site address (MAIL_FROM) is always one of yours. Done here, not in db.js: the CLI runs without the env file.
db.prepare("INSERT OR IGNORE INTO addresses (address, name) VALUES (lower(?), ?)").run(config.mailFrom, config.mailFromName);

server.listen(config.port, config.host, () => {
  console.log(`nulldex-admin listening on ${config.host}:${config.port}`);
});
setInterval(auth.cleanupSessions, 6 * 3600 * 1000).unref();
