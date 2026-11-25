#!/bin/bash
# Redeploy fulgurspice from origin/main on the self-host VM. The app is static (the
# ngspice engine runs in the browser as WebAssembly), so this builds it in a throwaway
# Node container and copies dist/ into nginx's root for spice.pontsho-mbizo.co.za.
# Same shape as the other apps' deploy.sh: pull, build, publish, check.
set -euo pipefail
cd ~/apps/fulgurspice
WEBROOT=/var/www/fulgurspice

echo "== fetching origin/main =="
git fetch origin main
git reset --hard origin/main

echo "== building (node:22 container, as this user so files stay ours) =="
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -v "$PWD":/app -w /app node:22-bookworm-slim \
  sh -c "npm ci --no-audit --no-fund && npm run build"

echo "== publishing dist/ to $WEBROOT =="
mkdir -p "$WEBROOT"
rsync -a --delete dist/ "$WEBROOT"/

echo "== check =="
test -s "$WEBROOT/index.html"
ls "$WEBROOT"/assets/worker-*.js >/dev/null
echo "fulgurspice deploy: OK"
