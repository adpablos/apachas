#!/usr/bin/env bash
# Deploy the latest main to the server: git pull + compose up.
# Usage: scripts/deploy.sh
# Requires tailnet SSH access to the server. See docs/deployment.md.
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-100.83.154.97}" # treasure-map-prod-01 (tailnet)
DEPLOY_USER="${DEPLOY_USER:-adpablos}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/treasure_map_prod_github_actions_ed25519}"
APP_DIR="/opt/apachas"
PUBLIC_URL="https://apachas.alexdepablos.es"

echo "→ Deploying to ${DEPLOY_USER}@${DEPLOY_HOST}:${APP_DIR}"
# Restart api and web because `up` does not detect changes in mounted files
# such as server/api.js or deployment/nginx/*.conf. Both services are
# stateless/config-only; api's data lives in the volume and both restarts
# take about a second.
ssh -i "${DEPLOY_SSH_KEY}" -o IdentitiesOnly=yes "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '${APP_DIR}' && git pull --ff-only && sudo docker compose up -d --wait && sudo docker compose restart api web"

echo "→ Checking ${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "${PUBLIC_URL}/api/health"
echo "✔ ${PUBLIC_URL} responds (web and api)"
