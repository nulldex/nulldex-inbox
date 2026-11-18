# nulldex-inbox

A small, self-hosted email inbox for your own domain. It receives mail through **Cloudflare Email Routing**,
stores it on your own server, and sends replies through **Brevo**, all from a clean web UI.
It also collects messages from your website's contact form.

No mail server to run and no port 25: everything travels over HTTPS.

```
                 ┌──────────────────────────┐
  someone emails │ Cloudflare Email Routing │──► Email Worker ──HTTPS + shared secret──┐
 you@domain.com  └──────────────────────────┘        │                                  ▼
                                                      └─ server down? forward to backup  ┌───────────────────┐
  website contact form ── POST /api/contact ───────────────────────────────────────────► │  Node.js server   │
                                                                                          │  SQLite (+ FTS5)  │
  you, in the browser ◄──────────────── admin UI (login) ───────────────────────────────►│  attachments      │
                                                                                          └─────────┬─────────┘
                                                              replies ── Brevo API ◄──────────────────┘
```

## Features

- **Inbox, Sent, Archive and Trash**, with unread counts, search (SQLite FTS5, diacritic-insensitive) and attachments
- **Reply and compose** with proper `In-Reply-To` / `References` headers, so replies thread in Gmail and Outlook
- **Contact form endpoint** for your public site, with a honeypot and rate limiting
- **Never loses mail:** if the server is unreachable, the Cloudflare Worker forwards the email to a backup address
- **Minimal footprint:** Node 22 built-in `node:sqlite`, a plain `http` server and one dependency (`mailparser`)
- Dark, responsive UI that works on phones too

## Security

Everything sensitive is enforced on the server. The browser code is only a UI.

| Threat | Protection |
|---|---|
| Password guessing | scrypt-hashed password; 5 failed logins per IP / 15 min plus 20 failed logins globally / hour |
| IP spoofing to dodge limits | listens on `127.0.0.1` only; the reverse proxy overwrites `X-Forwarded-For` |
| Session theft | random 256-bit token, stored hashed; cookie is `HttpOnly`, `Secure`, `SameSite=Strict` |
| CSRF | every state-changing request needs a custom header that cross-site requests can't send |
| Malicious email HTML | rendered in a sandboxed iframe: no scripts, no forms, no remote loads (tracking pixels are blocked) |
| XSS in the UI | all message data is inserted as text nodes; strict Content-Security-Policy |
| Fake inbound mail | `/api/inbound` requires a 256-bit shared secret (constant-time compare) |
| Dangerous attachments | always downloaded, never rendered inline (`application/octet-stream` + `nosniff`) |
| Server compromise blast radius | runs as an unprivileged system user under systemd hardening (`ProtectSystem=strict` and more) |

## Setup (short version)

1. **Server:** Ubuntu with Node 22+ and a reverse proxy with HTTPS (Caddy example below).
2. Copy the repo to `/opt/nulldex-admin` and run `bash deploy/setup-server.sh` as root.
   This creates `/etc/nulldex-admin.env` from `.env.example` with a fresh `INBOUND_SECRET`. Edit it with your domains.
3. Set the admin password: `nulldex-admin set-password`
4. **Cloudflare:** create a Worker from `cloudflare/email-worker.js`, add `INBOX_URL`, `FALLBACK_TO` and the
   `INBOUND_SECRET` secret, then point your Email Routing rules to the Worker.
5. **Brevo (optional, for sending):** authenticate your domain, add the sender, create a *restricted* API key
   (Transactional email only) and put it in `BREVO_API_KEY`.

```caddyfile
admin.example.com {
	request_body {
		max_size 32MB
	}
	reverse_proxy 127.0.0.1:3001
}

example.com {
	reverse_proxy /api/contact 127.0.0.1:3001
	# ... your site
}
```

## CLI

```bash
nulldex-admin set-password   # set or change the admin password (logs out all sessions)
nulldex-admin stats          # message counts per folder
```

## Project structure

```
server.js               HTTP server and routes
src/                    config, database, auth, mail parsing and sending
public/                 admin UI (vanilla JS, no build step)
cloudflare/             Email Worker
deploy/                 systemd unit, setup and deploy scripts
```
