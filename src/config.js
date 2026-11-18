const path = require("node:path");

const env = process.env;

module.exports = {
  port: Number(env.PORT || 3001),
  host: env.BIND || "127.0.0.1",
  dataDir: env.DATA_DIR || "/var/lib/nulldex-admin",
  adminHost: env.ADMIN_HOST || "admin.example.com",
  siteHosts: (env.SITE_HOSTS || "example.com,www.example.com").split(","),
  inboundSecret: env.INBOUND_SECRET || "",
  brevoApiKey: env.BREVO_API_KEY || "",
  mailFrom: env.MAIL_FROM || "hello@example.com",
  mailFromName: env.MAIL_FROM_NAME || "Inbox",
  messageIdDomain: (env.MAIL_FROM || "hello@example.com").split("@")[1],
  publicDir: path.join(__dirname, "..", "public"),
  maxInboundBytes: 30 * 1024 * 1024,
  sessionDays: 30,
};
