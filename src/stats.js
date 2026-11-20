// Numbers for the dashboard and analytics pages: server health, website traffic (from Caddy access logs) and mail.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { execFile } = require("node:child_process");
const db = require("./db");
const config = require("./config");

const DAY = 864e5;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10); // UTC day
function lastDays(n) {
  const out = [], today = Date.now();
  for (let i = n - 1; i >= 0; i--) out.push(dayKey(today - i * DAY));
  return out;
}

// ---------------------------------------------------------------- server
const readProc = f => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };

function cpuTimes() {
  const line = readProc("/proc/stat").split("\n")[0] || "";
  const n = line.trim().split(/\s+/).slice(1).map(Number);
  if (n.length < 4) return null;
  const idle = n[3] + (n[4] || 0);
  return { idle, total: n.reduce((a, b) => a + b, 0) };
}
function memory() {
  const m = {};
  for (const l of readProc("/proc/meminfo").split("\n")) {
    const [k, v] = l.split(":");
    if (v) m[k] = parseInt(v, 10) * 1024;
  }
  return { total: m.MemTotal || 0, used: (m.MemTotal || 0) - (m.MemAvailable || 0) };
}
function network() {
  let rx = 0, tx = 0;
  for (const l of readProc("/proc/net/dev").split("\n").slice(2)) {
    const [name, rest] = l.split(":");
    if (!rest || name.trim() === "lo") continue;
    const f = rest.trim().split(/\s+/).map(Number);
    rx += f[0]; tx += f[8];
  }
  return { rx, tx };
}
function disk() {
  try {
    const s = fs.statfsSync("/");
    const total = s.blocks * s.bsize;
    return { total, used: total - s.bavail * s.bsize };
  } catch { return { total: 0, used: 0 }; }
}

// CPU / memory history: one sample every 10 s, the last hour kept in memory
const history = [];
let prevCpu = cpuTimes();
function sample() {
  const now = cpuTimes();
  let cpu = 0;
  if (now && prevCpu && now.total > prevCpu.total) cpu = 100 * (1 - (now.idle - prevCpu.idle) / (now.total - prevCpu.total));
  prevCpu = now;
  const mem = memory();
  history.push({ t: Date.now(), cpu: Math.round(cpu * 10) / 10, mem: mem.total ? Math.round(1000 * mem.used / mem.total) / 10 : 0 });
  if (history.length > 360) history.shift();
}
sample();
setInterval(sample, 10_000).unref();

// is a systemd service running? (cached; systemctl is cheap but not free)
const svcCache = new Map();
function serviceState(name) {
  const c = svcCache.get(name);
  if (c && Date.now() - c.t < 15_000) return c.state;
  execFile("systemctl", ["is-active", name], { timeout: 3000 }, (err, out) => {
    svcCache.set(name, { t: Date.now(), state: (out || "").trim() || "unknown" });
  });
  return c ? c.state : "unknown";
}

// are the public sites answering? checked every minute
const SITES = (process.env.MONITOR_SITES || "").split(",").map(s => s.trim()).filter(Boolean);
const siteStatus = {};
async function checkSites() {
  for (const host of SITES) {
    const t0 = Date.now();
    try {
      const res = await fetch(`https://${host}/`, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(8000) });
      siteStatus[host] = { up: res.status < 500, status: res.status, ms: Date.now() - t0, checked: Date.now() };
    } catch (e) {
      siteStatus[host] = { up: false, status: 0, ms: null, checked: Date.now(), error: e.name };
    }
  }
}
setTimeout(checkSites, 2000).unref();
setInterval(checkSites, 60_000).unref();

function server() {
  const [up] = readProc("/proc/uptime").split(" ").map(Number);
  const load = readProc("/proc/loadavg").split(" ").slice(0, 3).map(Number);
  const mem = memory();
  const last = history[history.length - 1] || { cpu: 0 };
  return {
    cpu: last.cpu, load, cores: require("node:os").cpus().length,
    mem, disk: disk(), net: network(), uptime: up || 0,
    history: history.map(h => [h.t, h.cpu, h.mem]),
    services: Object.fromEntries(["caddy", "nulldex-admin", "nulldex-console"].map(s => [s, serviceState(s)])),
    sites: SITES.map(h => ({ host: h, ...(siteStatus[h] || { up: null }) })),
  };
}

// ---------------------------------------------------------------- website traffic
// Caddy writes one JSON line per request to /var/log/caddy/access-*.log (rotated files are .log.gz).
// A "page view" = a successful GET of a page (not an asset, API call or bot).
const LOG_DIR = process.env.ACCESS_LOG_DIR || "/var/log/caddy";
const BOT = /bot|crawl|spider|slurp|preview|monitor|uptime|curl|wget|python|go-http|node-fetch|axios|headless|lighthouse|facebookexternalhit|scan/i;
const ASSET = /\.(?!html?$)[a-z0-9]{1,6}$/i;
const header = (h, k) => (h && h[k] && h[k][0]) || "";

function device(ua) { return /iPad|Tablet/i.test(ua) ? "Tablet" : /Mobi|Android|iPhone/i.test(ua) ? "Mobile" : "Desktop"; }
function browser(ua) {
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/SamsungBrowser/.test(ua)) return "Samsung";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Other";
}
const bareHost = h => String(h || "").toLowerCase().replace(/^www\./, "").replace(/:\d+$/, "");

let cache = { t: 0, events: [] };
const salt = crypto.randomBytes(16); // visitor ids are hashes that can't be reversed and change on restart

function readEvents() {
  if (Date.now() - cache.t < 60_000) return cache.events;
  const events = [];
  const since = Date.now() - 92 * DAY;
  let files = [];
  try { files = fs.readdirSync(LOG_DIR).filter(f => /^access-.*\.(log|gz)$/.test(f)); } catch {}
  for (const f of files) {
    let text;
    try {
      const buf = fs.readFileSync(path.join(LOG_DIR, f));
      text = (f.endsWith(".gz") ? zlib.gunzipSync(buf) : buf).toString("utf8");
    } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line || line[0] !== "{") continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      const r = e.request || {};
      const ts = (e.ts || 0) * 1000;
      if (ts < since || r.method !== "GET" || (e.status !== 200 && e.status !== 304)) continue;
      const p = String(r.uri || "/").split("?")[0];
      if (p.startsWith("/api/") || p.startsWith("/_expo/") || p.startsWith("/assets/") || ASSET.test(p)) continue;
      const ua = header(r.headers, "User-Agent");
      if (!ua || BOT.test(ua)) continue;
      const site = bareHost(r.host);
      let ref = "";
      try { const h = bareHost(new URL(header(r.headers, "Referer")).hostname); if (h && h !== site) ref = h; } catch {}
      const ip = r.client_ip || r.remote_ip || "";
      events.push({
        ts, site, path: p.replace(/\/index\.html$/, "/").replace(/\.html$/, "") || "/", ref,
        dev: device(ua), br: browser(ua),
        vid: crypto.createHash("sha256").update(salt).update(ip).update(ua).digest("base64").slice(0, 12),
      });
    }
  }
  cache = { t: Date.now(), events };
  return events;
}

function top(map, n = 8) {
  return [...map].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ key: k, n: v }));
}

function traffic({ site = "", days = 30 } = {}) {
  const keys = lastDays(days);
  const from = keys[0];
  const ev = readEvents().filter(e => (!site || e.site === site) && dayKey(e.ts) >= from);
  const perDay = new Map(keys.map(k => [k, { views: 0, v: new Set() }]));
  const pages = new Map(), refs = new Map(), devs = new Map(), brs = new Map(), all = new Set();
  for (const e of ev) {
    const d = perDay.get(dayKey(e.ts));
    if (d) { d.views++; d.v.add(e.vid); }
    all.add(e.vid);
    const pg = site ? e.path : `${e.site}${e.path}`;
    pages.set(pg, (pages.get(pg) || 0) + 1);
    if (e.ref) refs.set(e.ref, (refs.get(e.ref) || 0) + 1);
    devs.set(e.dev, (devs.get(e.dev) || 0) + 1);
    brs.set(e.br, (brs.get(e.br) || 0) + 1);
  }
  const daily = keys.map(k => ({ day: k, views: perDay.get(k).views, visitors: perDay.get(k).v.size }));
  const sites = [...new Set(readEvents().map(e => e.site))].sort();
  return {
    days, site, sites: [...new Set([...SITES.map(bareHost), ...sites])],
    totals: { views: ev.length, visitors: all.size },
    daily, pages: top(pages), referrers: top(refs), devices: top(devs), browsers: top(brs),
    logging: fs.existsSync(LOG_DIR),
  };
}

// ---------------------------------------------------------------- mail
function mail(days = 30) {
  const keys = lastDays(days);
  const since = Date.parse(keys[0] + "T00:00:00Z");
  const rows = db.prepare(`SELECT date, source FROM messages WHERE source != 'sent' AND date >= ?`).all(since);
  const perDay = new Map(keys.map(k => [k, 0]));
  let forms = 0;
  for (const r of rows) { const k = dayKey(r.date); if (perDay.has(k)) perDay.set(k, perDay.get(k) + 1); if (r.source === "form") forms++; }
  const byAddress = db.prepare(`SELECT mailbox AS key, COUNT(*) AS n FROM messages
    WHERE source != 'sent' AND date >= ? AND mailbox IS NOT NULL GROUP BY mailbox ORDER BY n DESC`).all(since);
  const unread = db.prepare("SELECT COUNT(*) n FROM messages WHERE folder = 'inbox' AND read = 0").get().n;
  const sent = db.prepare("SELECT COUNT(*) n FROM messages WHERE source = 'sent' AND date >= ?").get(since).n;
  return { received: rows.length, forms, sent, unread, daily: keys.map(k => ({ day: k, n: perDay.get(k) })), byAddress };
}

function latestMail(n = 5) {
  return db.prepare(`SELECT id, from_name, from_addr, subject, date, read, mailbox, source FROM messages
    WHERE folder = 'inbox' ORDER BY date DESC LIMIT ?`).all(n);
}

module.exports = { server, traffic, mail, latestMail, dayKey };
