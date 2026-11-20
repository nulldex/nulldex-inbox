#!/bin/bash
# One-time / repeatable server setup for the inbox. Run as root after files are in /opt/nulldex-admin.
set -e

id nulldex >/dev/null 2>&1 || useradd --system --home /var/lib/nulldex-admin --shell /usr/sbin/nologin nulldex
mkdir -p /var/lib/nulldex-admin
chown -R nulldex:nulldex /var/lib/nulldex-admin
chmod 750 /var/lib/nulldex-admin

# config + secrets file: created once from the example, never overwritten
if [ ! -f /etc/nulldex-admin.env ]; then
  umask 077
  sed "s/^INBOUND_SECRET=.*/INBOUND_SECRET=$(openssl rand -hex 32)/" /opt/nulldex-admin/.env.example > /etc/nulldex-admin.env
  chmod 600 /etc/nulldex-admin.env
  echo ">>> Created /etc/nulldex-admin.env with a fresh INBOUND_SECRET. Edit it to set your domains and BREVO_API_KEY."
fi

cd /opt/nulldex-admin
npm ci --omit=dev --no-audit --no-fund --loglevel=error 2>/dev/null || npm install --omit=dev --no-audit --no-fund --loglevel=error
chown -R root:root /opt/nulldex-admin
chmod -R a+rX /opt/nulldex-admin

install -m 755 deploy/nulldex-admin.sh /usr/local/bin/nulldex-admin
install -m 644 deploy/nulldex-admin.service /etc/systemd/system/nulldex-admin.service
install -m 644 deploy/nulldex-console.service /etc/systemd/system/nulldex-console.service
systemctl daemon-reload

# console helper: only restart it when it actually changed (a restart ends the open shell)
sum=$(cat console/console_helper.py deploy/nulldex-console.service | sha256sum | cut -d" " -f1)
if [ "$(cat /var/lib/nulldex-console.sha 2>/dev/null)" != "$sum" ]; then
  systemctl enable nulldex-console >/dev/null 2>&1
  systemctl restart nulldex-console
  echo "$sum" > /var/lib/nulldex-console.sha
fi
systemctl enable nulldex-admin >/dev/null 2>&1
systemctl restart nulldex-admin
sleep 1
systemctl is-active nulldex-admin
