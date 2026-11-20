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
async function loadList() {
  const params = new URLSearchParams({ folder: state.folder });
  if (state.q) params.set("q", state.q);
  if (state.mailbox) params.set("mailbox", state.mailbox);
  const data = await api(`/api/messages?${params}`);
  state.messages = data.messages;
  updateCounts(data.counts);
  renderList();
}

function updateCounts(c) {
  state.unread = c.unread;
  if (c.byMailbox) state.byMailbox = c.byMailbox;
  $("c-inbox").textContent = c.unread || "";
  document.title = (c.unread ? `(${c.unread}) ` : "") + "Inbox · Nulldex Admin";
  renderMailboxes();
}

// ---------- addresses (sidebar filter) ----------
const shortAddr = a => a.replace(/@.*$/, "@");
function renderMailboxes() {
  const all = [...state.addresses.map(a => a.address), ...state.others];
  const nav = $("mailboxes");
  $("mailboxesLabel").hidden = nav.hidden = all.length < 2; // only worth showing with 2+ addresses
  nav.replaceChildren();
  const item = (value, label, unread, title) => {
    const b = el("button", value === state.mailbox ? "active" : "");
    b.dataset.mailbox = value; b.title = title || label;
    b.append(el("span", "mb-name", label), el("span", "count", unread ? String(unread) : ""));
    nav.append(b);
  };
  item("", "All addresses", 0);
  for (const a of all) item(a, shortAddr(a), state.byMailbox[a] || 0, a);
}
$("mailboxes").addEventListener("click", e => {
  const b = e.target.closest("button[data-mailbox]");
  if (!b) return;
  state.mailbox = b.dataset.mailbox;
  $("app").classList.remove("menu-open");
  closeMessage(); renderMailboxes(); loadList();
});

function renderList() {
  const list = $("list");
  list.replaceChildren();
  $("folderTitle").textContent = (state.q ? `Search: ${state.q}` : state.folder[0].toUpperCase() + state.folder.slice(1)) +
    (state.mailbox ? ` · ${state.mailbox}` : "");
  $("emptyTrash").hidden = !(state.folder === "trash" && state.messages.length && !state.q);
  if (!state.messages.length) { list.append(el("li", "empty-list", state.q ? "Nothing found" : "No messages")); return; }

  for (const m of state.messages) {
    const li = el("li");
    if (!m.read) li.classList.add("unread");
    if (state.current && state.current.id === m.id) li.classList.add("selected");
    const who = state.folder === "sent" ? `To: ${m.to_addr}` : (m.from_name || m.from_addr || "Unknown");
    const row1 = el("div", "l-row");
    row1.append(el("span", "l-from", who), el("span", "l-date", fmtDate(m.date)));
    const subj = el("div", "l-subject");
    if (m.source === "form") subj.append(el("span", "tag-form", "form"));
    else if (!state.mailbox && m.mailbox && !$("mailboxes").hidden) subj.append(el("span", "tag-box", shortAddr(m.mailbox)));
    subj.append(document.createTextNode((m.has_attach ? "📎 " : "") + (m.subject || "(no subject)")));
    li.append(row1, subj, el("div", "l-snippet", m.snippet || ""));
    li.addEventListener("click", () => openMessage(m.id));
    list.append(li);
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

  const item = state.messages.find(m => m.id === id);
  if (item && !item.read) { item.read = 1; state.unread = Math.max(0, state.unread - (msg.folder === "inbox" ? 1 : 0)); updateCounts({ unread: state.unread }); }
  renderList();
}

function closeMessage() {
  state.current = null;
  $("message").hidden = true; $("emptyState").hidden = false;
  $("app").classList.remove("reading");
  renderList();
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
  closeMessage(); loadList();
});
$("menuBtn").addEventListener("click", () => $("app").classList.toggle("menu-open"));
$("refreshBtn").addEventListener("click", () => loadList().then(() => toast("Up to date")));
let searchTimer;
$("search").addEventListener("input", e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.q = e.target.value.trim(); closeMessage(); loadList(); }, 300);
});
$("logoutBtn").addEventListener("click", async () => { await api("/api/logout", { method: "POST" }).catch(() => {}); showLogin(); });

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
    await loadList();
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
