#!/usr/bin/env node
// Admin command line:  nulldex-admin set-password | stats
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
  } else if (cmd === "stats") {
    console.table(db.prepare("SELECT folder, COUNT(*) AS messages, SUM(read = 0) AS unread FROM messages GROUP BY folder").all());
  } else {
    console.log("Usage: nulldex-admin set-password | stats");
  }
})();
