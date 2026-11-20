#!/usr/bin/env node
// Admin command line:  nulldex-admin set-password | disable-2fa | stats
const auth = require("./src/auth");
const db = require("./src/db");

function askHidden(prompt) {
  return new Promise(resolve => {
    process.stdout.write(prompt);
    const stdin = process.stdin;
    if (!stdin.isTTY) { // allow piping: echo pass | nulldex-admin set-password
      let data = "";
      stdin.on("data", c => (data += c)).on("end", () => resolve(data.split(/\r?\n/)[0]));
      return;
    }
    stdin.setRawMode(true); stdin.resume(); stdin.setEncoding("utf8");
    let value = "";
    stdin.on("data", function onData(ch) {
      if (ch === "\r" || ch === "\n" || ch === "\u0004") {
        stdin.setRawMode(false); stdin.pause(); stdin.removeListener("data", onData);
        process.stdout.write("\n"); resolve(value);
      } else if (ch === "\u0003") { process.stdout.write("\n"); process.exit(1); }
      else if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
      else value += ch;
    });
  });
}

(async () => {
  const cmd = process.argv[2];
  if (cmd === "set-password") {
    const p1 = await askHidden("New admin password (min 12 chars): ");
    if (p1.length < 12) { console.error("Too short."); process.exit(1); }
    if (process.stdin.isTTY) {
      const p2 = await askHidden("Repeat password: ");
      if (p1 !== p2) { console.error("Passwords don't match."); process.exit(1); }
    }
    auth.setPassword(p1);
    console.log("Password saved. All existing sessions were logged out.");
  } else if (cmd === "disable-2fa") {
    require("./src/totp").disable();
    console.log("Two-factor authentication disabled. Log in with your password and set it up again.");
  } else if (cmd === "stats") {
    console.table(db.prepare("SELECT mailbox, folder, COUNT(*) AS messages, SUM(read = 0) AS unread FROM messages GROUP BY mailbox, folder").all());
  } else if (cmd === "addresses") {
    console.table(db.prepare("SELECT address, name AS sender_name FROM addresses ORDER BY address").all());
  } else if (cmd === "add-address" || cmd === "set-name") {
    // nulldex-admin add-address leo@example.com Leo Example
    const address = (process.argv[3] || "").trim().toLowerCase();
    const name = process.argv.slice(4).join(" ").trim() || null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) { console.error(`Usage: nulldex-admin ${cmd} <address> [sender name]`); process.exit(1); }
    db.prepare("INSERT INTO addresses (address, name) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET name = COALESCE(excluded.name, name)")
      .run(address, name);
    console.log(`${address}${name ? ` (sends as "${name}")` : ""} is one of your addresses: its mail is filtered in the sidebar and you can send from it.`);
  } else if (cmd === "remove-address") {
    const address = (process.argv[3] || "").trim().toLowerCase();
    db.prepare("DELETE FROM addresses WHERE address = ?").run(address);
    console.log(`${address} removed (its existing mail stays; you just can't send from it any more).`);
  } else {
    console.log(`Usage: nulldex-admin <command>
  set-password                          set or change the admin password (logs out all sessions)
  disable-2fa                           emergency: turn off two-factor login
  addresses                             list your addresses
  add-address <address> [sender name]   add an address you can send from and filter by
  set-name <address> <sender name>      change the name people see when you send from it
  remove-address <address>              stop sending from an address
  stats                                 message counts per address and folder`);
  }
})();
