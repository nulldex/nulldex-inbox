"use strict";

const $ = id => document.getElementById(id);
// mailbox: "" = all addresses, otherwise show only mail to/from that one address
const state = { folder: "inbox", q: "", mailbox: "", messages: [], current: null, unread: 0, canSend: false,
  from: "", addresses: [], others: [], byMailbox: {} };

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || "GET",
    credentials: "same-origin",
    headers: { "x-nulldex": "1", ...(opts.body ? { "content-type": "application/json" } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.error === "Not logged in") { showLogin(); throw new Error("Not logged in"); }
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

function toast(text) {
  const t = $("toast"); t.textContent = text; t.hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), 2600);
}

// ---------- formatting ----------
function fmtDate(ms, long = false) {
  const d = new Date(ms), now = new Date();
  if (long) return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const opts = { day: "numeric", month: "short" };
  if (d.getFullYear() !== now.getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString(undefined, opts);
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

// ---------- login ----------
async function showLogin() {
  $("app").hidden = true; $("login").hidden = false; $("loginPassword").focus();
  try {
    const info = await api("/api/login-info");
    $("loginCode").hidden = !info.twoFactor;
    $("loginCode").required = info.twoFactor;
  } catch (e) {}
}

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginError").textContent = "";
  try {
    await api("/api/login", { method: "POST", body: { password: $("loginPassword").value, code: $("loginCode").value } });
    $("loginPassword").value = ""; $("loginCode").value = "";
    start();
  } catch (err) { $("loginError").textContent = err.message; $("loginCode").value = ""; }
});

// ---------- list ----------
// animate: fade the new rows in (folder / address / search changes). Background refreshes swap silently.
let listSeq = 0;
async function loadList({ animate = false } = {}) {
  const seq = ++listSeq;
  const params = new URLSearchParams({ folder: state.folder });
  if (state.q) params.set("q", state.q);
  if (state.mailbox) params.set("mailbox", state.mailbox);
  // keep the old list on screen (dimmed) until the new one arrives: no empty flash, no jump
  const dim = animate ? setTimeout(() => $("list").classList.add("loading"), 90) : 0;
  try {
    const data = await api(`/api/messages?${params}`);
    if (seq !== listSeq) return; // a newer request is on its way; drop this stale answer
    state.messages = data.messages;
    updateCounts(data.counts);
    renderList(animate);
  } finally {
    clearTimeout(dim);
    if (seq === listSeq) $("list").classList.remove("loading");
  }
}

function updateCounts(c) {
  state.unread = c.unread;
  if (c.byMailbox) state.byMailbox = c.byMailbox;
  $("c-inbox").textContent = c.unread || "";
  $("railUnread").hidden = !c.unread;
  document.title = (c.unread ? `(${c.unread}) ` : "") + "Nulldex Admin";
  renderMailboxes();
}

// ---------- addresses (tabs above the list) ----------
const shortAddr = a => a.replace(/@.*$/, "");
function renderMailboxes() {
  const all = [...state.addresses.map(a => a.address), ...state.others];
  const nav = $("mailboxes");
  nav.hidden = all.length < 2; // only worth showing with 2+ addresses
  const values = ["", ...all];
  // rebuild only when the set of addresses changes; otherwise update in place so the underline can slide
  if (nav.dataset.keys !== values.join("|")) {
    nav.dataset.keys = values.join("|");
    nav.replaceChildren(...values.map(v => {
      const b = el("button", "tab");
      b.dataset.mailbox = v; b.title = v || "All addresses";
      b.append(el("span", null, v ? shortAddr(v) : "All"), el("span", "count"));
      return b;
    }));
  }
  for (const b of nav.children) {
    b.classList.toggle("active", b.dataset.mailbox === state.mailbox);
    const n = b.dataset.mailbox ? state.byMailbox[b.dataset.mailbox] || 0 : 0;
    b.lastChild.textContent = n ? String(n) : "";
  }
}
$("mailboxes").addEventListener("click", e => {
  const b = e.target.closest("button[data-mailbox]");
  if (!b || b.dataset.mailbox === state.mailbox) return;
  state.mailbox = b.dataset.mailbox;
  closeMessage(); renderMailboxes(); loadList({ animate: true });
});

function folderTitle() {
  return state.q ? `Search: ${state.q}` : state.folder[0].toUpperCase() + state.folder.slice(1);
}

function renderList(animate = false) {
  const list = $("list");
  $("folderTitle").textContent = folderTitle();
  $("emptyTrash").hidden = !(state.folder === "trash" && state.messages.length && !state.q);
  if (animate) list.scrollTop = 0;
  if (!state.messages.length) {
    list.replaceChildren(el("li", "empty-list" + (animate ? " in" : ""), state.q ? "Nothing found" : "No messages"));
    return;
  }
  const showBox = !state.mailbox && !$("mailboxes").hidden;
  list.replaceChildren(...state.messages.map((m, i) => {
    const li = el("li");
    li.dataset.id = m.id;
    if (!m.read) li.classList.add("unread");
    if (state.current && state.current.id === m.id) li.classList.add("selected");
    if (animate && i < 20) { li.classList.add("in"); li.style.setProperty("--i", i); }
    const who = state.folder === "sent" ? `To: ${m.to_addr}` : (m.from_name || m.from_addr || "Unknown");
    const row1 = el("div", "l-row");
    row1.append(el("span", "l-from", who));
    if (showBox && m.mailbox) row1.append(el("span", "l-box", shortAddr(m.mailbox)));
    row1.append(el("span", "l-date", fmtDate(m.date)));
    const subj = el("div", "l-subject");
    if (m.source === "form") subj.append(el("span", "tag-form", "form"));
    subj.append(document.createTextNode((m.has_attach ? "📎 " : "") + (m.subject || "(no subject)")));
    li.append(row1, subj, el("div", "l-snippet", m.snippet || ""));
    li.addEventListener("click", () => openMessage(m.id));
    return li;
  }));
}

// mark the open message in the list without rebuilding it (no flicker)
function markSelected() {
  for (const li of $("list").children) {
    const id = Number(li.dataset.id);
    li.classList.toggle("selected", !!state.current && state.current.id === id);
    const m = state.messages.find(x => x.id === id);
    if (m) li.classList.toggle("unread", !m.read);
  }
}

// ---------- reading ----------
// "Simple" HTML (typical Gmail/Outlook personal mail) is shown as clean text on the dark theme.
// Rich HTML (images, tables, custom styling) gets the sandboxed white frame.
function isRichHtml(html) {
  return /<(img|table|style|svg|video|button)\b/i.test(html) || /background(-color)?\s*:/i.test(html);
}

function renderText(text) {
  const wrap = el("div", "text-card");
  const urlRe = /(https?:\/\/[^\s<>"')\]]+)/g;
  for (const line of (text || "").replace(/\r/g, "").split("\n")) {
    const p = el("div", /^\s*>/.test(line) || /^On .+wrote:$/.test(line.trim()) ? "t-line quote" : "t-line");
    let last = 0;
    for (const m of line.matchAll(urlRe)) {
      p.append(document.createTextNode(line.slice(last, m.index)));
      const a = el("a", null, m[0]);
      a.href = m[0]; a.target = "_blank"; a.rel = "noopener noreferrer";
      p.append(a);
      last = m.index + m[0].length;
    }
    p.append(document.createTextNode(line.slice(last) || (last ? "" : " ")));
    wrap.append(p);
  }
  return wrap;
}

function renderBody(msg) {
  const body = $("msgBody");
  body.replaceChildren();
  if (!msg.html || (!isRichHtml(msg.html) && (msg.text || "").trim())) {
    body.append(renderText(msg.text));
    return;
  }
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-same-origin allow-popups allow-popups-to-escape-sandbox"); // no scripts, no forms
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.srcdoc =
    `<!doctype html><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:">` +
    `<base target="_blank"><style>body{margin:16px;font:14px/1.5 Arial,Helvetica,sans-serif;color:#111;word-wrap:break-word}img{max-width:100%;height:auto}</style>` +
    msg.html;
  frame.addEventListener("load", () => {
    try { frame.style.height = frame.contentDocument.documentElement.scrollHeight + 8 + "px"; } catch (e) {}
  });
  const card = el("div", "html-card");
  card.append(frame);
  body.append(card);
}

function initials(name) {
  const parts = (name || "?").replace(/[<>@].*$/, "").trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

async function openMessage(id) {
  const msg = await api(`/api/messages/${id}`);
  state.current = msg;
  $("emptyState").hidden = true;
  $("message").hidden = false;
  $("msgSubject").textContent = msg.subject || "(no subject)";
  $("msgAvatar").textContent = initials(msg.from_name || msg.from_addr);
  $("msgFromName").textContent = msg.from_name || msg.from_addr || "";
  $("msgFromAddr").textContent = msg.from_name ? `<${msg.from_addr}>` : "";
  $("msgBadge").hidden = msg.source !== "form";
  $("msgTo").textContent = msg.to_addr || "";
  $("msgDate").textContent = fmtDate(msg.date, true);
  $("archiveBtn").textContent = msg.folder === "archive" || msg.folder === "trash" ? "Move to inbox" : "Archive";
  $("deleteBtn").textContent = msg.folder === "trash" ? "Delete forever" : "Delete";
  $("unreadBtn").hidden = msg.folder === "sent";
  $("replyBtn").hidden = msg.folder === "sent";

  const att = $("msgAttachments");
  att.replaceChildren();
  for (const a of msg.attachments || []) {
    const li = el("li"), link = el("a", null, `📎 ${a.filename} · ${(a.size / 1024).toFixed(0)} KB`);
    link.href = `/api/attachments/${a.id}`;
    li.append(link); att.append(li);
  }
  renderBody(msg);
  $("app").classList.add("reading");
  const art = $("message"); art.classList.remove("in"); void art.offsetWidth; art.classList.add("in");

  const item = state.messages.find(m => m.id === id);
  if (item && !item.read) {
    item.read = 1;
    if (msg.folder === "inbox") {
      state.unread = Math.max(0, state.unread - 1);
      if (msg.mailbox && state.byMailbox[msg.mailbox]) state.byMailbox[msg.mailbox]--;
    }
    updateCounts({ unread: state.unread });
  }
  markSelected();
}

function closeMessage() {
  state.current = null;
  $("message").hidden = true; $("emptyState").hidden = false;
  $("app").classList.remove("reading");
  markSelected();
}

async function moveCurrent(folder, note) {
  const id = state.current.id;
  await api(`/api/messages/${id}`, { method: "PATCH", body: { folder } });
  toast(note); closeMessage(); loadList();
}

$("archiveBtn").addEventListener("click", () => {
  const f = state.current.folder;
  if (f === "archive" || f === "trash") moveCurrent("inbox", "Moved to inbox");
  else moveCurrent("archive", "Archived");
});
$("deleteBtn").addEventListener("click", async () => {
  if (state.current.folder === "trash" && !confirm("Delete this message forever?")) return;
  await api(`/api/messages/${state.current.id}`, { method: "DELETE" });
  toast(state.current.folder === "trash" ? "Deleted forever" : "Moved to trash");
  closeMessage(); loadList();
});
$("unreadBtn").addEventListener("click", async () => {
  await api(`/api/messages/${state.current.id}`, { method: "PATCH", body: { read: false } });
  toast("Marked as unread"); closeMessage(); loadList();
});
$("backBtn").addEventListener("click", closeMessage);
$("emptyTrash").addEventListener("click", async () => {
  if (!confirm("Delete everything in trash forever?")) return;
  await api("/api/trash/empty", { method: "POST" });
  toast("Trash emptied"); loadList();
});

// ---------- compose / reply ----------
const ownAddr = a => state.addresses.some(x => x.address === a);
function openCompose({ to = "", subject = "", text = "", inReplyTo = "", title = "New email", from = "" } = {}) {
  const f = $("composeForm");
  const sel = $("composeFrom");
  sel.replaceChildren(...state.addresses.map(a => {
    const o = el("option", null, a.name ? `${a.name} <${a.address}>` : a.address); o.value = a.address; return o;
  }));
  // reply from the address the mail came to; new mail from the address you're filtering by; else the main one
  sel.value = [from, state.mailbox, state.from].find(ownAddr) || state.addresses[0]?.address || "";
  f.to.value = to; f.cc.value = ""; f.subject.value = subject; f.text.value = text; f.inReplyTo.value = inReplyTo;
  $("composeTitle").textContent = title;
  $("composeError").textContent = state.canSend ? "" : "Sending isn't set up yet (Brevo key missing).";
  $("compose").showModal();
  (to ? f.text : f.to).focus();
  if (to) f.text.setSelectionRange(0, 0);
}

$("composeBtn").addEventListener("click", () => openCompose());
$("composeClose").addEventListener("click", () => $("compose").close());
$("replyBtn").addEventListener("click", () => {
  const m = state.current;
  const quoted = (m.text || "").split("\n").map(l => "> " + l).join("\n");
  openCompose({
    title: "Reply",
    to: m.reply_to || m.from_addr || "",
    subject: /^re:/i.test(m.subject || "") ? m.subject : `Re: ${m.subject || ""}`,
    text: `\n\n\nOn ${fmtDate(m.date, true)}, ${m.from_name || m.from_addr} wrote:\n${quoted}`,
    inReplyTo: m.message_id || "",
    from: m.mailbox || "",
  });
});

$("composeForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, btn = $("sendBtn");
  btn.disabled = true; $("composeError").textContent = "";
  try {
    await api("/api/send", { method: "POST", body: {
      from: f.from.value, to: f.to.value, cc: f.cc.value, subject: f.subject.value, text: f.text.value, inReplyTo: f.inReplyTo.value || undefined,
    }});
    $("compose").close(); toast("Sent ✓");
    if (state.folder === "sent") loadList();
  } catch (err) { $("composeError").textContent = err.message; }
  finally { btn.disabled = false; }
});

// ---------- security: two-factor ----------
function showTfView(view, me) {
  for (const id of ["tfOff", "tfSetup", "tfRecovery", "tfOn"]) $(id).hidden = id !== view;
  const on = view === "tfOn" || view === "tfRecovery";
  $("tfPill").textContent = on ? "ON" : "OFF";
  $("tfPill").classList.toggle("on", on);
  $("tfStatus").textContent = on
    ? (me && me.recoveryLeft != null ? `Active · ${me.recoveryLeft} recovery codes left` : "Active")
    : "Not enabled";
}

$("secBtn").addEventListener("click", async () => {
  const me = await api("/api/me");
  showTfView(me.twoFactor ? "tfOn" : "tfOff", me);
  state.addresses = me.addresses || [];
  const list = $("namesList"); list.replaceChildren(); $("namesError").textContent = "";
  for (const a of state.addresses) {
    const lab = el("label", null, a.address), inp = el("input");
    inp.name = a.address; inp.value = a.name || ""; inp.maxLength = 80; inp.placeholder = "Sender name";
    lab.append(inp); list.append(lab);
  }
  $("tfOn").reset(); $("tfDisError").textContent = "";
  $("secDialog").showModal();
});
$("secClose").addEventListener("click", () => $("secDialog").close());

$("tfStart").addEventListener("click", async () => {
  const s = await api("/api/2fa/setup", { method: "POST" });
  $("tfQr").src = s.qr;
  $("tfSecret").textContent = s.secret.match(/.{1,4}/g).join(" ");
  $("tfCode").value = ""; $("tfError").textContent = "";
  showTfView("tfSetup");
  $("tfCode").focus();
});

$("tfSetup").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    const r = await api("/api/2fa/enable", { method: "POST", body: { code: $("tfCode").value } });
    $("tfCodes").textContent = r.recovery.join("\n");
    showTfView("tfRecovery");
    $("tfQr").removeAttribute("src"); $("tfSecret").textContent = "";
  } catch (err) { $("tfError").textContent = err.message; }
});

$("tfCopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("tfCodes").textContent); toast("Recovery codes copied"); }
  catch (e) { toast("Select the codes and copy them manually"); }
});

$("tfOn").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await api("/api/2fa/disable", { method: "POST", body: { password: $("tfDisPw").value, code: $("tfDisCode").value } });
    toast("2FA disabled"); showTfView("tfOff");
  } catch (err) { $("tfDisError").textContent = err.message; }
});

$("namesForm").addEventListener("submit", async e => {
  e.preventDefault();
  try {
    for (const inp of $("namesList").querySelectorAll("input")) {
      const a = state.addresses.find(x => x.address === inp.name);
      if (a && (a.name || "") !== inp.value.trim()) {
        await api("/api/addresses", { method: "PATCH", body: { address: inp.name, name: inp.value.trim() } });
        a.name = inp.value.trim();
      }
    }
    toast("Names saved");
  } catch (err) { $("namesError").textContent = err.message; }
});

// ---------- password ----------
$("pwBtn").addEventListener("click", () => { $("secDialog").close(); $("pwForm").reset(); $("pwError").textContent = ""; $("pwDialog").showModal(); });
$("pwClose").addEventListener("click", () => $("pwDialog").close());
$("pwForm").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await api("/api/password", { method: "POST", body: { current: f.current.value, next: f.next.value } });
    $("pwDialog").close(); toast("Password changed. Log in again."); showLogin();
  } catch (err) { $("pwError").textContent = err.message; }
});

// ---------- navigation ----------
$("folders").addEventListener("click", e => {
  const b = e.target.closest("button[data-folder]");
  if (!b) return;
  document.querySelectorAll("#folders button").forEach(x => x.classList.toggle("active", x === b));
  state.folder = b.dataset.folder; state.q = ""; $("search").value = "";
  $("app").classList.remove("menu-open");
  closeMessage(); loadList({ animate: true });
});
$("menuBtn").addEventListener("click", () => $("app").classList.toggle("menu-open"));
$("refreshBtn").addEventListener("click", () => loadList().then(() => toast("Up to date")));
let searchTimer;
$("search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); closeMessage(); loadList({ animate: true }); }, 300);
});
$("logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); showLogin(); });

// ---------- rail: Mail / Dashboard / Console ----------
const VIEWS = ["mail", "dashboard", "console"];
function showView(name) {
  if (!VIEWS.includes(name)) name = "mail";
  for (const v of VIEWS) $(`view-${v}`).hidden = v !== name;
  document.querySelectorAll(".rail-btn[data-view]").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (location.hash.slice(1) !== name) history.replaceState(null, "", name === "mail" ? location.pathname : `#${name}`);
}
$("rail").addEventListener("click", e => {
  const b = e.target.closest(".rail-btn[data-view]");
  if (b) showView(b.dataset.view);
});
window.addEventListener("hashchange", () => showView(location.hash.slice(1)));

// ---------- start ----------
let pollTimer;
async function start() {
  try {
    const me = await api("/api/me");
    state.canSend = me.canSend; state.from = me.from;
    state.addresses = me.addresses || []; state.others = me.others || [];
    $("meFrom").textContent = me.from;
    renderMailboxes();
    $("login").hidden = true; $("app").hidden = false;
    showView(location.hash.slice(1));
    await loadList({ animate: true });
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const before = state.unread;
        const c = await api("/api/counts");
        updateCounts(c);
        if (c.unread !== before && state.folder === "inbox" && !state.q) loadList();
      } catch (e) {}
    }, 30000);
  } catch (e) { /* showLogin already called on 401 */ }
}
start();
