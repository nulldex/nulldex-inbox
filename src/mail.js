const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { simpleParser } = require("mailparser");
const db = require("./db");
const config = require("./config");

const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

const firstAddr = list => (list && list.value && list.value[0]) || {};
const addrList = list => (list && list.value ? list.value.map(a => a.address).filter(Boolean).join(", ") : "");
const safeName = s => (s || "file").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "file";

const insertMessage = db.prepare(`
  INSERT INTO messages (folder, source, message_id, in_reply_to, references_, from_name, from_addr, reply_to,
                        to_addr, cc_addr, subject, text, html, date, read, has_attach, meta, created)
  VALUES (:folder, :source, :message_id, :in_reply_to, :references_, :from_name, :from_addr, :reply_to,
          :to_addr, :cc_addr, :subject, :text, :html, :date, :read, :has_attach, :meta, :created)
`);
const insertAttachment = db.prepare(
  "INSERT INTO attachments (message_id, filename, content_type, size, path) VALUES (?, ?, ?, ?, ?)"
);

function save(fields) {
  const row = {
    folder: "inbox", source: "email", message_id: null, in_reply_to: null, references_: null,
    from_name: null, from_addr: null, reply_to: null, to_addr: null, cc_addr: null,
    subject: "(no subject)", text: "", html: null, date: Date.now(), read: 0, has_attach: 0,
    meta: null, created: Date.now(), ...fields,
  };
  return Number(insertMessage.run(row).lastInsertRowid);
}

// ---------- incoming email (raw MIME from the Cloudflare worker) ----------
async function storeInbound(raw, envelope = {}) {
  const mail = await simpleParser(raw, { skipTextToHtml: true });

  // Skip duplicates (Cloudflare can retry)
  if (mail.messageId) {
    const dup = db.prepare("SELECT id FROM messages WHERE message_id = ? AND source = 'email'").get(mail.messageId);
    if (dup) return dup.id;
  }

  let html = typeof mail.html === "string" ? mail.html : null;
  const files = [];
  for (const a of mail.attachments || []) {
    // inline images (cid:) -> data: URIs so they show without loading anything remote
    if (html && a.contentId && a.contentType?.startsWith("image/") && a.size <= MAX_INLINE_IMAGE) {
      const cid = a.contentId.replace(/^<|>$/g, "");
      const dataUri = `data:${a.contentType};base64,${a.content.toString("base64")}`;
      html = html.split(`cid:${cid}`).join(dataUri);
      if (a.related) continue;
    }
    files.push(a);
  }

  const from = firstAddr(mail.from);
  const replyTo = firstAddr(mail.replyTo);
  const id = save({
    source: "email",
    message_id: mail.messageId || null,
    in_reply_to: mail.inReplyTo || null,
    references_: Array.isArray(mail.references) ? mail.references.join(" ") : mail.references || null,
    from_name: from.name || null,
    from_addr: from.address || envelope.from || null,
    reply_to: replyTo.address || null,
    to_addr: addrList(mail.to) || envelope.to || null,
    cc_addr: addrList(mail.cc) || null,
    subject: mail.subject || "(no subject)",
    text: mail.text || "",
    html,
    date: mail.date ? mail.date.getTime() : Date.now(),
    has_attach: files.length ? 1 : 0,
    meta: JSON.stringify({ envelopeFrom: envelope.from || null, envelopeTo: envelope.to || null }),
  });

  if (files.length) {
    const dir = path.join(config.dataDir, "attachments", String(id));
    fs.mkdirSync(dir, { recursive: true });
    files.forEach((a, i) => {
      const file = path.join(dir, `${i}-${safeName(a.filename)}`);
      fs.writeFileSync(file, a.content);
      insertAttachment.run(id, a.filename || "attachment", a.contentType || "application/octet-stream", a.size || a.content.length, file);
    });
  }
  return id;
}

// ---------- contact form on nulldex.net ----------
function storeForm({ name, email, type, message, lang }) {
  return save({
    source: "form",
    from_name: name,
    from_addr: email,
    reply_to: email,
    to_addr: config.mailFrom,
    subject: `${type || "Contact form"} — ${name}`,
    text: message,
    meta: JSON.stringify({ type, lang }),
  });
}

// ---------- sending (Brevo transactional API) ----------
const escapeHtml = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const textToHtml = t =>
  `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#111">${
    escapeHtml(t).replace(/\n/g, "<br>")
  }</div>`;

async function sendMail({ to, cc, subject, text, inReplyTo }) {
  if (!config.brevoApiKey) {
    const err = new Error("Sending is not set up yet (missing Brevo API key).");
    err.status = 503;
    throw err;
  }
  const toList = to.split(",").map(s => s.trim()).filter(Boolean);
  const ccList = (cc || "").split(",").map(s => s.trim()).filter(Boolean);

  let references = null;
  if (inReplyTo) {
    const orig = db.prepare("SELECT references_ FROM messages WHERE message_id = ?").get(inReplyTo);
    references = [orig?.references_, inReplyTo].filter(Boolean).join(" ");
  }
  const messageId = `<${crypto.randomUUID()}@${config.messageIdDomain}>`;
  const headers = { "Message-ID": messageId };
  if (inReplyTo) { headers["In-Reply-To"] = inReplyTo; headers["References"] = references; }

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "api-key": config.brevoApiKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      sender: { name: config.mailFromName, email: config.mailFrom },
      to: toList.map(email => ({ email })),
      ...(ccList.length ? { cc: ccList.map(email => ({ email })) } : {}),
      subject,
      textContent: text,
      htmlContent: textToHtml(text),
      headers,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const err = new Error(`Brevo error ${res.status}: ${body.slice(0, 300)}`);
    err.status = 502;
    throw err;
  }

  return save({
    folder: "sent", source: "sent", read: 1,
    message_id: messageId, in_reply_to: inReplyTo || null, references_: references,
    from_name: config.mailFromName, from_addr: config.mailFrom,
    to_addr: toList.join(", "), cc_addr: ccList.join(", ") || null,
    subject, text,
  });
}

module.exports = { storeInbound, storeForm, sendMail };
