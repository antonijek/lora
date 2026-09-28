#!/bin/sh
# Deploy Lore na produkciju — JEDINI način da se kod pošalje na server.
#
# Isti principi kao preferans/tools/deploy.sh:
#  - engine/dist i server/dist se UVEK prave na serveru (gitignored su),
#  - ako build ne uspe, pm2 se NE restartuje (set -e) — stari proces radi dalje,
#  - JWT_SECRET se kopira iz preferans .env NA SERVERU (nikad kroz git/lokalno).
#
# Prvi put postaviti i nginx + sertifikat:  sh tools/deploy.sh --setup
set -e

VPS_HOST="root@213.199.32.240"
REMOTE_DIR="/var/www/lora"
DOMAIN="lora.antonije.dev"

if ! git diff --quiet HEAD; then
  echo "!! Imate necommitovane izmene — deploy šalje samo poslednji commit (HEAD)."
fi

echo "==> Šaljem $(git rev-parse --short HEAD) na $VPS_HOST:$REMOTE_DIR"
git archive --format=tar HEAD | ssh -o ConnectTimeout=10 "$VPS_HOST" "mkdir -p $REMOTE_DIR && tar -x -C $REMOTE_DIR"

ssh -o ConnectTimeout=10 "$VPS_HOST" "
  set -e
  cd $REMOTE_DIR
  if [ ! -f server/.env ]; then
    echo '==> Pravim server/.env (JWT_SECRET iz preferansa)'
    SECRET_LINE=\$(grep '^JWT_SECRET=' /var/www/preferans/server/.env)
    printf 'PORT=3002\nAUTH_URL=http://127.0.0.1:3001\n%s\nDB_PATH=$REMOTE_DIR/server/lora.db\n' \"\$SECRET_LINE\" > server/.env
    chmod 600 server/.env
  fi
  echo '==> Build engine'
  cd engine && npm ci --no-audit --no-fund --loglevel=error && npm run build && cd ..
  echo '==> Build server'
  cd server && npm ci --no-audit --no-fund --loglevel=error && npm run build
  test -f dist/index.js && test -f dist/rooms/driver.js && test -f dist/socket/roomEvents.js
  if pm2 describe lora-server >/dev/null 2>&1; then pm2 reload lora-server; else pm2 start ecosystem.config.cjs; fi
  pm2 save >/dev/null
  sleep 2
  curl -fsS http://127.0.0.1:3002/api/health && echo
  pm2 logs lora-server --lines 10 --nostream
"

if [ "$1" = "--setup" ]; then
  echo "==> nginx + sertifikat za $DOMAIN"
  ssh -o ConnectTimeout=10 "$VPS_HOST" "
    set -e
    if [ ! -f /etc/nginx/sites-available/$DOMAIN ]; then
      cat > /etc/nginx/sites-available/$DOMAIN <<'NGINX'
server {
    server_name $DOMAIN;
    listen 80;

    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \"upgrade\";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 90;
    }
}
NGINX
      ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/$DOMAIN
    fi
    nginx -t
    systemctl reload nginx
    certbot --nginx -d $DOMAIN --non-interactive --agree-tos --redirect
    nginx -t && systemctl reload nginx
  "
fi

echo "==> Gotovo: https://$DOMAIN/"
