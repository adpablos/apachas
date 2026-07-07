#!/usr/bin/env bash
# Deploy the latest main to the server: git pull + compose up.
# Usage: scripts/deploy.sh
# Requires tailnet SSH access to the server. See docs/despliegue.md.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-100.83.154.97}" # treasure-map-prod-01 (tailnet)
DEPLOY_USER="${DEPLOY_USER:-adpablos}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/treasure_map_prod_github_actions_ed25519}"
APP_DIR="/opt/collados-party"
PUBLIC_URL="https://collados.alexdepablos.es"

echo "→ Deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:${APP_DIR}"
# Restart api because `up` does not detect changes in mounted files such as
# server/api.js. The service is stateless; data lives in the volume and restart
# takes about a second.
ssh -i "${DEPLOY_SSH_KEY}" -o IdentitiesOnly=yes "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '${APP_DIR}' && git pull --ff-only && sudo docker compose up -d --wait && sudo docker compose restart api"

echo "→ Checking ${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "${PUBLIC_URL}/api/salud"
echo "✔ ${PUBLIC_URL} responds (web and api)"
