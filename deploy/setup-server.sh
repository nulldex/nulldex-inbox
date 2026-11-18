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
systemctl daemon-reload
systemctl enable nulldex-admin >/dev/null 2>&1
systemctl restart nulldex-admin
sleep 1
systemctl is-active nulldex-admin
