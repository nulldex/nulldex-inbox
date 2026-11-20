"use strict";
// Dashboard, Analytics and Console pages. Uses helpers from app.js ($, el, api, fmtDate, showView, openMessage, viewHooks).

// ---------------------------------------------------------------- formatting
const nf = new Intl.NumberFormat();
const num = n => nf.format(Math.round(n || 0));
function bytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}
function duration(s) {
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
const dayLabel = (k, long) => new Date(k + "T12:00:00Z").toLocaleDateString(undefined, long ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short" });
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e; };
function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v)), n = v / p;
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

// ---------------------------------------------------------------- charts (single series, monochrome)
// One tooltip element per chart, positioned over the hovered mark.
function chartTip(box) {
  let t = box.querySelector(".chart-tip");
  if (!t) { t = el("div", "chart-tip"); t.hidden = true; box.append(t); }
  return t;
}
function placeTip(box, tip, x, y, html) {
  tip.replaceChildren(...html);
  tip.hidden = false;
  const w = tip.offsetWidth, bw = box.clientWidth;
  tip.style.left = `${Math.max(0, Math.min(bw - w, x - w / 2))}px`;
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 10)}px`;
}

// bars: [{ label, value, tip: [line1, line2] }]
function barChart(box, data, { height = 160, unit = "" } = {}) {
  box.replaceChildren();
  const W = Math.max(240, box.clientWidth), H = height, padL = 30, padB = 22, padT = 8;
  const max = niceMax(Math.max(...data.map(d => d.value), 0));
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "svg-chart", role: "img" });
  const plotH = H - padB - padT, plotW = W - padL;
  // recessive grid + y labels
  for (let i = 0; i <= 2; i++) {
    const v = max * i / 2, y = padT + plotH - plotH * i / 2;
    svg.append(svgEl("line", { x1: padL, x2: W, y1: y, y2: y, class: i ? "grid" : "axis" }));
    const t = svgEl("text", { x: padL - 8, y: y + 3, class: "tick", "text-anchor": "end" }); t.textContent = num(v); svg.append(t);
  }
  const slot = plotW / data.length, bw = Math.max(2, Math.min(28, slot - 2)); // 2px gap between bars
  data.forEach((d, i) => {
    const x = padL + i * slot + (slot - bw) / 2, h = d.value ? Math.max(2, plotH * d.value / max) : 0, y = padT + plotH - h;
    const r = Math.min(3, bw / 2, h);
    if (h) svg.append(svgEl("path", { class: "bar", d: `M${x},${y + h}V${y + r}q0,-${r} ${r},-${r}h${bw - 2 * r}q${r},0 ${r},${r}V${y + h}Z`, style: `--i:${i}` }));
    const hit = svgEl("rect", { x: padL + i * slot, y: padT, width: slot, height: plotH, class: "hit" });
    hit.addEventListener("pointerenter", () => {
      svg.querySelectorAll(".bar").forEach(b => b.classList.remove("on"));
      const bar = [...svg.querySelectorAll(".bar")].find(b => b.style.getPropertyValue("--i") == i);
      if (bar) bar.classList.add("on");
      placeTip(box, chartTip(box), (x + bw / 2) * box.clientWidth / W, y * box.clientHeight / H,
        (d.tip || [d.label, num(d.value) + unit]).map((l, j) => el("div", j ? "ct-v" : "ct-l", l)));
    });
    svg.append(hit);
  });
  // sparse x labels: first, middle, last
  const idx = [...new Set([0, Math.floor((data.length - 1) / 2), data.length - 1])];
  for (const i of idx) {
    const t = svgEl("text", { x: padL + i * slot + slot / 2, y: H - 6, class: "tick", "text-anchor": i === 0 ? "start" : i === data.length - 1 ? "end" : "middle" });
    t.textContent = data[i].label; svg.append(t);
  }
  svg.addEventListener("pointerleave", () => { chartTip(box).hidden = true; svg.querySelectorAll(".bar.on").forEach(b => b.classList.remove("on")); });
  box.append(svg);
}

// line over time with crosshair: points [[ms, value]], fixed 0..100 scale for percentages
function lineChart(box, points, { height = 140, max = 100, unit = "%" } = {}) {
  box.replaceChildren();
  if (points.length < 2) { box.append(el("p", "faint small chart-empty", "Collecting data…")); return; }
  const W = Math.max(240, box.clientWidth), H = height, padL = 30, padB = 22, padT = 8;
  const plotH = H - padB - padT, plotW = W - padL;
  const t0 = points[0][0], t1 = points[points.length - 1][0];
  const X = t => padL + plotW * (t - t0) / Math.max(1, t1 - t0), Y = v => padT + plotH - plotH * Math.min(v, max) / max;
  const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H, class: "svg-chart" });
  for (let i = 0; i <= 2; i++) {
    const y = padT + plotH - plotH * i / 2;
    svg.append(svgEl("line", { x1: padL, x2: W, y1: y, y2: y, class: i ? "grid" : "axis" }));
    const t = svgEl("text", { x: padL - 8, y: y + 3, class: "tick", "text-anchor": "end" }); t.textContent = `${max * i / 2}${unit}`; svg.append(t);
  }
  const d = points.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[1]).toFixed(1)}`).join("");
  svg.append(svgEl("path", { d: `${d}L${X(t1)},${padT + plotH}L${padL},${padT + plotH}Z`, class: "area" }));
  svg.append(svgEl("path", { d, class: "line" }));
  const fmtT = t => new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  [[t0, "start"], [t1, "end"]].forEach(([t, a]) => { const x = svgEl("text", { x: X(t), y: H - 6, class: "tick", "text-anchor": a }); x.textContent = fmtT(t); svg.append(x); });
  const cross = svgEl("line", { class: "cross", y1: padT, y2: padT + plotH, x1: 0, x2: 0, visibility: "hidden" });
  const dot = svgEl("circle", { class: "dot", r: 4, visibility: "hidden" });
  svg.append(cross, dot);
  const hit = svgEl("rect", { x: padL, y: 0, width: plotW, height: H, class: "hit" });
  hit.addEventListener("pointermove", e => {
    const r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * W / r.width;
    const t = t0 + (mx - padL) / plotW * (t1 - t0);
    let best = points[0]; for (const p of points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    const x = X(best[0]), y = Y(best[1]);
    cross.setAttribute("x1", x); cross.setAttribute("x2", x); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", x); dot.setAttribute("cy", y); dot.setAttribute("visibility", "visible");
    placeTip(box, chartTip(box), x * box.clientWidth / W, y * box.clientHeight / H, [el("div", "ct-l", fmtT(best[0])), el("div", "ct-v", `${best[1]}${unit}`)]);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); chartTip(box).hidden = true; });
  svg.append(hit);
  box.append(svg);
}

// ranked list with thin bars: [{ key, n }]
function barList(ul, items, empty = "Nothing yet") {
  ul.replaceChildren();
  if (!items.length) { ul.append(el("li", "faint small bars-empty", empty)); return; }
  const max = items[0].n;
  items.forEach((it, i) => {
    const li = el("li"); li.style.setProperty("--i", i);
    const fill = el("span", "bar-fill"); fill.style.width = `${Math.max(2, 100 * it.n / max)}%`;
    li.append(fill, el("span", "bar-key", it.key), el("span", "bar-n mono", num(it.n)));
    li.title = `${it.key}: ${num(it.n)}`;
    ul.append(li);
  });
}

function meter(label, used, total, text) {
  const pct = total ? Math.round(100 * used / total) : 0;
  const row = el("div", "meter");
  const top = el("div", "meter-top"); top.append(el("span", null, label), el("span", "mono", text || `${pct}%`));
  const track = el("div", "meter-track"), fill = el("div", "meter-fill");
  fill.style.width = `${pct}%`; if (pct >= 85) fill.classList.add("hot");
  track.append(fill); row.append(top, track);
  return row;
}

function healthBlock(box, s, wide = false) {
  box.replaceChildren();
  const meters = el("div", "meters");
  meters.append(
    meter("CPU", s.cpu, 100, `${s.cpu}% · load ${s.load.map(n => n.toFixed(2)).join(" ")}`),
    meter("Memory", s.mem.used, s.mem.total, `${bytes(s.mem.used)} / ${bytes(s.mem.total)}`),
    meter("Disk", s.disk.used, s.disk.total, `${bytes(s.disk.used)} / ${bytes(s.disk.total)}`),
  );
  const facts = el("div", "facts");
  const fact = (k, v) => { const f = el("div", "fact"); f.append(el("span", "faint", k), el("span", "mono", v)); facts.append(f); };
  fact("Uptime", duration(s.uptime));
  if (wide) { fact("Network in", bytes(s.net.rx)); fact("Network out", bytes(s.net.tx)); fact("Cores", String(s.cores)); }
  const status = el("div", "status-list");
  const stat = (name, ok, note) => {
    const r = el("div", "status"); const d = el("span", "sdot " + (ok === null ? "" : ok ? "ok" : "bad"));
    r.append(d, el("span", null, name), el("span", "faint mono", note)); status.append(r);
  };
  for (const site of s.sites) stat(site.host, site.up, site.up === null ? "checking" : site.up ? `${site.ms} ms` : "down");
  for (const [svc, st] of Object.entries(s.services)) stat(svc, st === "unknown" ? null : st === "active", st);
  box.append(meters, facts, status);
}

// ---------------------------------------------------------------- terminal
// One persistent shell lives on the server; every terminal here is a window onto it.
const TERM_THEME = {
  background: "#080808", foreground: "#e4e4e4", cursor: "#ffffff", cursorAccent: "#080808",
  selectionBackground: "rgba(255,255,255,0.22)",
  black: "#1a1a1a", red: "#ff6b6b", green: "#4ade80", yellow: "#e5c07b", blue: "#7aa2f7", magenta: "#c792ea", cyan: "#67e8f9", white: "#d4d4d4",
  brightBlack: "#5c5c5c", brightRed: "#ff8787", brightGreen: "#86efac", brightYellow: "#f0d399", brightBlue: "#9ab8ff", brightMagenta: "#ddb3ff", brightCyan: "#a5f3fc", brightWhite: "#ffffff",
};
const fontReady = document.fonts ? document.fonts.load('13px "JetBrains Mono"').catch(() => {}) : Promise.resolve();

function createTerminal(box, { readOnly = false, onState = () => {} } = {}) {
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", ui-monospace, monospace', fontSize: readOnly ? 10.5 : 13, lineHeight: 1.25,
    cursorBlink: !readOnly, cursorStyle: "bar", disableStdin: readOnly, allowProposedApi: false,
    scrollback: readOnly ? 200 : 5000, theme: TERM_THEME, convertEol: false,
    ...(readOnly ? { cols: 120, rows: 13 } : {}),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(box);
  let ws = null, closedByUs = false, retry = 0, retryTimer;

  const sendSize = () => { if (!readOnly && ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "r", c: term.cols, r: term.rows })); };
  const refit = () => { if (!readOnly && box.offsetParent) { try { fit.fit(); } catch {} sendSize(); } };
  const ro = new ResizeObserver(() => refit());
  ro.observe(box);

  function connect() {
    clearTimeout(retryTimer);
    closedByUs = false;
    onState("connecting");
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/api/console${readOnly ? "?ro=1" : ""}`);
    ws.binaryType = "arraybuffer";
    let first = true;
    ws.onopen = () => { retry = 0; onState("live"); refit(); };
    ws.onmessage = e => {
      if (first) { term.reset(); first = false; } // first message is the scrollback: rebuild the screen from it
      term.write(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      onState("closed");
      if (!closedByUs && retry < 5) retryTimer = setTimeout(connect, 800 * 2 ** retry++);
    };
  }
  if (!readOnly) term.onData(d => { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: "i", d })); });

  return {
    term, connect, refit,
    focus: () => term.focus(),
    disconnect() { closedByUs = true; clearTimeout(retryTimer); if (ws) ws.close(); },
    dispose() { this.disconnect(); ro.disconnect(); term.dispose(); },
  };
}

function setDot(dot, st) { dot.className = "term-dot " + (st === "live" ? "ok" : st === "connecting" ? "wait" : "bad"); }

// ---------------------------------------------------------------- DASHBOARD
const dash = { timer: null, term: null, twoFactor: null };

function greeting() {
  const h = new Date().getHours();
  return `${h < 5 ? "Late night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"} · ${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}`;
}

async function loadDashboard() {
  let d;
  try { d = await api("/api/dashboard"); } catch { return; }
  $("dashGreeting").textContent = greeting();
  // tiles
  $("dUnread").textContent = num(d.mail.unread);
  $("dUnreadSub").textContent = d.mail.unread ? "waiting for you" : "inbox zero";
  $("railUnread").hidden = !d.mail.unread;
  const today = d.web.today || { visitors: 0, views: 0 };
  $("dVisitors").textContent = num(today.visitors);
  $("dVisitorsSub").textContent = `${num(today.views)} page views`;
  $("dCpu").textContent = `${Math.round(d.server.cpu)}%`;
  $("dCpuSub").textContent = `load ${d.server.load[0].toFixed(2)}`;
  const memPct = d.server.mem.total ? Math.round(100 * d.server.mem.used / d.server.mem.total) : 0;
  $("dMem").textContent = `${memPct}%`;
  $("dMemSub").textContent = `${bytes(d.server.mem.used)} of ${bytes(d.server.mem.total)}`;

  // recent mail
  const ul = $("dMail"); ul.replaceChildren();
  if (!d.mail.latest.length) ul.append(el("li", "faint small mini-empty", "No mail yet"));
  for (const m of d.mail.latest) {
    const li = el("li", m.read ? "" : "unread"); li.dataset.stop = "1";
    const top = el("div", "mini-row");
    top.append(el("span", "mini-from", m.from_name || m.from_addr || "Unknown"), el("span", "mini-date", fmtDate(m.date)));
    li.append(top, el("div", "mini-subj", (m.source === "form" ? "Form · " : "") + (m.subject || "(no subject)")));
    li.addEventListener("click", async () => { showView("mail"); await openMessage(m.id); });
    ul.append(li);
  }

  barChart($("dTraffic"), d.web.daily.map(x => ({ label: dayLabel(x.day), value: x.visitors, tip: [dayLabel(x.day, true), `${num(x.visitors)} visitors · ${num(x.views)} views`] })), { height: Math.max(150, $("dTraffic").clientHeight) });
  healthBlock($("dHealth"), d.server);

  // console preview (read-only)
  dash.twoFactor = d.console.twoFactor;
  if (!d.console.twoFactor) {
    $("dTermNote").hidden = false; $("dTermNote").textContent = "Turn on two-factor login in Settings to use the console.";
  } else if (!dash.term && window.Terminal) {
    dash.term = createTerminal($("dTerm"), { readOnly: true, onState: st => setDot($("dTermDot"), st) });
    dash.term.connect();
  }
}

viewHooks.dashboard = {
  show() {
    fontReady.then(loadDashboard);
    clearInterval(dash.timer);
    dash.timer = setInterval(loadDashboard, 10_000);
    if (dash.term) dash.term.connect();
  },
  hide() {
    clearInterval(dash.timer);
    if (dash.term) dash.term.disconnect();
  },
};

// ---------------------------------------------------------------- ANALYTICS
const an = { site: "", days: 30, timer: null };

async function loadAnalytics() {
  let d;
  try { d = await api(`/api/analytics?days=${an.days}&site=${encodeURIComponent(an.site)}`); } catch { return; }
  const t = d.traffic;
  // site filter (built from what exists)
  const seg = $("aSite");
  const keys = ["", ...t.sites];
  if (seg.dataset.keys !== keys.join("|")) {
    seg.dataset.keys = keys.join("|");
    seg.replaceChildren(...keys.map(k => { const b = el("button", null, k || "All sites"); b.dataset.site = k; return b; }));
  }
  for (const b of seg.children) b.classList.toggle("active", b.dataset.site === an.site);

  $("aVisitors").textContent = num(t.totals.visitors);
  $("aVisitorsSub").textContent = `last ${an.days} days`;
  $("aViews").textContent = num(t.totals.views);
  $("aViewsSub").textContent = t.totals.visitors ? `${(t.totals.views / t.totals.visitors).toFixed(1)} per visitor` : "–";
  $("aMail").textContent = num(d.mail.received);
  $("aMailSub").textContent = `${num(d.mail.sent)} sent · ${num(d.mail.unread)} unread`;
  $("aForms").textContent = num(d.mail.forms);

  barChart($("aTraffic"), t.daily.map(x => ({ label: dayLabel(x.day), value: x.visitors, tip: [dayLabel(x.day, true), `${num(x.visitors)} visitors · ${num(x.views)} views`] })), { height: 200 });
  barList($("aPages"), t.pages, "No page views yet");
  barList($("aRefs"), t.referrers, "No referrers yet");
  barList($("aDevices"), t.devices, "No data yet");
  barList($("aBrowsers"), t.browsers, "No data yet");
  barChart($("aMailChart"), d.mail.daily.map(x => ({ label: dayLabel(x.day), value: x.n, tip: [dayLabel(x.day, true), `${num(x.n)} received`] })), { height: 140 });
  lineChart($("aCpu"), d.server.history.map(h => [h[0], h[1]]));
  lineChart($("aMem"), d.server.history.map(h => [h[0], h[2]]));
  healthBlock($("aHealth"), d.server, true);
}

$("aSite").addEventListener("click", e => {
  const b = e.target.closest("button[data-site]"); if (!b) return;
  an.site = b.dataset.site; loadAnalytics();
});
$("aDays").addEventListener("click", e => {
  const b = e.target.closest("button[data-days]"); if (!b) return;
  an.days = Number(b.dataset.days);
  for (const x of $("aDays").children) x.classList.toggle("active", x === b);
  loadAnalytics();
});

viewHooks.analytics = {
  show() { loadAnalytics(); clearInterval(an.timer); an.timer = setInterval(loadAnalytics, 30_000); },
  hide() { clearInterval(an.timer); },
};

// ---------------------------------------------------------------- CONSOLE
const con = { term: null };
const stateText = { connecting: "connecting…", live: "connected", closed: "disconnected" };

viewHooks.console = {
  async show() {
    let me; try { me = await api("/api/me"); } catch { return; }
    $("cLocked").hidden = me.twoFactor; $("cTerm").hidden = !me.twoFactor; $("cReconnect").hidden = !me.twoFactor;
    if (!me.twoFactor) { setDot($("cDot"), "closed"); $("cState").textContent = "locked"; return; }
    await fontReady;
    if (!con.term) {
      con.term = createTerminal($("cTerm"), { onState: st => { setDot($("cDot"), st); $("cState").textContent = stateText[st]; } });
      con.term.connect();
    }
    requestAnimationFrame(() => { con.term.refit(); con.term.focus(); });
  },
  hide() {}, // keep the connection while you look at other pages
};
$("cReconnect").addEventListener("click", () => { if (con.term) { con.term.disconnect(); con.term.connect(); con.term.focus(); } });

// logging out closes every terminal
$("logoutBtn").addEventListener("click", () => {
  if (con.term) { con.term.dispose(); con.term = null; }
  if (dash.term) { dash.term.dispose(); dash.term = null; }
});

// charts follow the window width
let resizeT;
window.addEventListener("resize", () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { if (currentView === "analytics") loadAnalytics(); else if (currentView === "dashboard") loadDashboard(); }, 200);
});
