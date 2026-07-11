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
ssh -i "${DEPLOY_SSH_KEY}" -o IdentitiesOnly=yes "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '${APP_DIR}' && git pull --ff-only && release=\$(git rev-parse HEAD) && sudo APP_RELEASE=\"\$release\" docker compose up -d --wait"

DEPLOYED_SHA="$(ssh -i "${DEPLOY_SSH_KEY}" -o IdentitiesOnly=yes "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '${APP_DIR}' && git rev-parse HEAD")"

echo "→ Checking ${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "${PUBLIC_URL}"
HEALTH="$(curl -fsS --retry 3 --retry-delay 2 "${PUBLIC_URL}/api/health")"
HEALTH_RELEASE="$(printf '%s' "${HEALTH}" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
if [[ "${HEALTH_RELEASE}" != "${DEPLOYED_SHA}" ]]; then
  echo "Health reports release '${HEALTH_RELEASE}', expected '${DEPLOYED_SHA}'" >&2
  exit 1
fi
echo "✔ ${PUBLIC_URL} responds on release ${DEPLOYED_SHA}"
