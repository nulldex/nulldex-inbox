# nulldex-administrative-website

A small, self-hosted admin panel for one person running their own domain and server:

- **Dashboard**: new mail, today's visitors, server health and a live view of the console, all on one page
- **Mail**: an inbox for your own domain (several addresses in one inbox), the website's contact form, replies
- **Analytics**: website visits from the web server's own access logs, so there are no cookies or tracking scripts
- **Console**: a terminal for the server in the browser, protected by two-factor login

No mail server and no port 25. Mail arrives through **Cloudflare Email Routing**, is stored on your server and is
sent through **Brevo**, all over HTTPS.

```
                 ┌──────────────────────────┐
  someone emails │ Cloudflare Email Routing │──► Email Worker ──HTTPS + shared secret──┐
 you@domain.com  └──────────────────────────┘        │                                  ▼
                                                      └─ server down? forward to backup  ┌───────────────────┐
  website contact form ── POST /api/contact ───────────────────────────────────────────► │  Node.js server   │
                                                                                          │  SQLite (+ FTS5)  │
  you, in the browser ◄──────────── admin UI (login + 2FA) ────────────────────────────► │  attachments      │
                                                                                          └──┬──────┬─────┬───┘
                                                       replies ── Brevo API ◄────────────────┘      │     │
                                         web server access logs (read-only) ─── analytics ─────────┘     │
                   console helper (root, unix socket, one persistent shell) ◄── console websocket ────────┘
```

## Features

**Mail**
- Inbox, Sent, Archive and Trash, with unread counts, search (SQLite FTS5, diacritic-insensitive) and attachments
- Several addresses in one inbox (e.g. a public `contact@` and a personal one): address tabs, per-address unread
  counts, and you pick the From address when writing (replies default to the address the mail came to)
- Replies thread correctly in Gmail and Outlook (`In-Reply-To` / `References`)
- A contact form endpoint for your public site, with a honeypot and rate limiting
- Never loses mail: if the server can't be reached, the Cloudflare Worker forwards the email to a backup address

**Dashboard and analytics**
- Visitors, page views, top pages, referrers, devices and browsers per site, over 7, 30 or 90 days. Built from the web
  server's JSON access logs; visitors are counted with salted hashes that are never stored
- Mail per day, contact form submissions
- Server: CPU and memory over the last hour, disk, uptime, network, systemd service status, uptime checks of your sites

**Console**
- A real terminal (xterm.js) for the server. One persistent shell, like a tiny tmux: reload the page or come back
  later and it's still there. The dashboard shows a read-only live preview

**General**
- Two-factor login with any authenticator app (TOTP with `node:crypto`, no auth libraries)
- Node 22's built-in `node:sqlite`, a plain `http` server and few dependencies (`mailparser`, `qrcode`, `ws`, `@xterm/*`)
- A dark, responsive UI that also works on phones, with no build step

## Security

Everything sensitive is enforced on the server. The browser code is only a UI.

| Threat | Protection |
|---|---|
| Password guessing | scrypt-hashed password; 5 failed logins per IP / 15 min plus 20 failed logins globally / hour |
| Stolen password | optional **two-factor login (TOTP)** with replay protection and 8 single-use recovery codes; the error never reveals which factor was wrong |
| Console abuse | the console only opens for a logged-in session on an account **with 2FA turned on**; the websocket checks the `Origin` header so other sites can't use your cookie (cross-site websocket hijacking); read-only viewers' keystrokes are dropped before they reach the shell |
| Console privilege | the web app itself runs unprivileged; the root shell lives in a separate helper reachable only through a unix socket owned by `root:<app group>` with mode `0660` |
| IP spoofing to dodge limits | listens on `127.0.0.1` only; the reverse proxy overwrites `X-Forwarded-For` |
| Session theft | random 256-bit token, stored hashed; cookie is `HttpOnly`, `Secure`, `SameSite=Strict` |
| CSRF | every state-changing request needs a custom header that cross-site requests can't send |
| Malicious email HTML | rendered in a sandboxed iframe: no scripts, no forms, no remote loads (tracking pixels are blocked) |
| XSS in the UI | all message data is inserted as text nodes; strict Content-Security-Policy (own origin only) |
| Fake inbound mail | `/api/inbound` requires a 256-bit shared secret (constant-time compare) |
| Dangerous attachments | always downloaded, never rendered inline (`application/octet-stream` + `nosniff`) |
| Server compromise blast radius | the web app runs as an unprivileged system user under systemd hardening (`ProtectSystem=strict` and more) |

The console is a root shell by design. Turn on 2FA, keep your recovery codes offline, and if you don't want a web
console, don't install `nulldex-console.service`: everything else keeps working.

## Setup (short version)

1. **Server:** Ubuntu with Node 22+, Python 3, and a reverse proxy with HTTPS (Caddy example below).
2. Copy the repo to `/opt/nulldex-admin` and run `bash deploy/setup-server.sh` as root.
   This creates `/etc/nulldex-admin.env` from `.env.example` with a fresh `INBOUND_SECRET`. Edit it with your domains.
3. Set the admin password with `nulldex-admin set-password`, then log in and turn on 2FA under Settings.
4. **Cloudflare:** create a Worker from `cloudflare/email-worker.js`, add `INBOX_URL`, `FALLBACK_TO` and the
   `INBOUND_SECRET` secret, then point your Email Routing rules (custom addresses and/or catch-all) to the Worker.
5. **Brevo (optional, for sending):** authenticate your domain, create a *restricted* API key
   (Transactional email only) and put it in `BREVO_API_KEY`.
6. **Analytics (optional):** let the web server write JSON access logs to `ACCESS_LOG_DIR` as `access-<name>.log`,
   readable by the app's group (`SupplementaryGroups=` in the unit file).

```caddyfile
admin.example.com {
	request_body {
		max_size 32MB
	}
	reverse_proxy 127.0.0.1:3001
}

example.com {
	log {
		output file /var/log/caddy/access-example.log {
			roll_size 20MiB
			roll_keep_for 2160h
			mode 0640
		}
		format json
	}
	reverse_proxy /api/contact 127.0.0.1:3001
	# ... your site
}
```

## CLI

```bash
nulldex-admin set-password                          # set or change the admin password (logs out all sessions)
nulldex-admin disable-2fa                           # emergency: turn off two-factor login if you lost your phone and recovery codes
nulldex-admin addresses                             # list your addresses
nulldex-admin add-address <address> [sender name]   # another address you can send from and filter by
nulldex-admin set-name <address> <sender name>      # the name recipients see for that address
nulldex-admin remove-address <address>              # stop sending from an address
nulldex-admin stats                                 # message counts per address and folder
```

## Project structure

```
server.js               HTTP server, routes and the console websocket
src/                    config, database, auth, 2FA, mail parsing and sending, stats
public/                 admin UI (vanilla JS, no build step)
console/                root console helper (Python standard library, one persistent pty)
cloudflare/             Email Worker
deploy/                 systemd units, setup and deploy scripts
```
