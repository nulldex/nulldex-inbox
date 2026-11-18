#!/bin/sh
# Wrapper so you can run:  nulldex-admin set-password   /   nulldex-admin stats
exec runuser -u nulldex -- env DATA_DIR=/var/lib/nulldex-admin /usr/bin/node --disable-warning=ExperimentalWarning /opt/nulldex-admin/cli.js "$@"
