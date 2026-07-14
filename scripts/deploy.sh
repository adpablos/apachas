#!/usr/bin/env bash
# Release the latest main to production and record its product version.
# Usage: scripts/deploy.sh v0.MINOR.0-beta.N
# Requires tailnet SSH access to the server and an authenticated GitHub CLI.
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/deploy.sh v0.MINOR.0-beta.N

Every new Git SHA deployed to production must receive a new product version.
Prepare the dated version section in CHANGELOG.md and leave Unreleased empty
before running this command from a clean, current main branch.
USAGE
}

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

[[ $# -eq 1 ]] || { usage; exit 64; }
VERSION="$1"
[[ "$VERSION" =~ ^v0\.([1-9][0-9]*)\.0-beta\.([1-9][0-9]*)$ ]] \
  || fail "Invalid beta version '$VERSION'. Expected v0.MINOR.0-beta.N." 64
TARGET_MINOR="${BASH_REMATCH[1]}"
TARGET_BETA="${BASH_REMATCH[2]}"
VERSION_NUMBER="${VERSION#v}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DEPLOY_HOST="${DEPLOY_HOST:-100.83.154.97}" # treasure-map-prod-01 (tailnet)
DEPLOY_USER="${DEPLOY_USER:-adpablos}"
DEPLOY_SSH_KEY="${DEPLOY_SSH_KEY:-$HOME/.ssh/treasure_map_prod_github_actions_ed25519}"
APP_DIR="/opt/apachas"
PUBLIC_URL="https://apachas.alexdepablos.es"

for command in git gh ssh curl awk grep mktemp head node; do
  command -v "$command" >/dev/null || fail "Required command '$command' is unavailable." 69
done
[[ -r "$DEPLOY_SSH_KEY" ]] || fail "Deployment SSH key is unavailable: $DEPLOY_SSH_KEY" 66

git fetch origin main --tags
[[ "$(git branch --show-current)" == "main" ]] \
  || fail "Production releases must run from main." 65
[[ -z "$(git status --porcelain)" ]] \
  || fail "Production releases require a clean working tree." 65

LOCAL_SHA="$(git rev-parse HEAD)"
REMOTE_SHA="$(git rev-parse origin/main)"
[[ "$LOCAL_SHA" == "$REMOTE_SHA" ]] \
  || fail "Local main '$LOCAL_SHA' does not match origin/main '$REMOTE_SHA'." 65

grep -Eq "^## \[${VERSION_NUMBER//./\.}\] - [0-9]{4}-[0-9]{2}-[0-9]{2}$" CHANGELOG.md \
  || fail "CHANGELOG.md has no dated section for $VERSION_NUMBER." 65

UNRELEASED_BODY="$(awk '
  /^## \[Unreleased\]$/ { copy = 1; next }
  copy && /^## \[/ { exit }
  copy { print }
' CHANGELOG.md)"
if printf '%s\n' "$UNRELEASED_BODY" | grep -Eq '^(### |[-*] )'; then
  fail "Unreleased still contains release notes. Move them into $VERSION_NUMBER first." 65
fi

NOTES="$(mktemp)"
trap 'rm -f "$NOTES"' EXIT
awk -v heading="## [${VERSION_NUMBER}]" '
  index($0, heading " - ") == 1 { copy = 1; next }
  copy && /^## \[/ { exit }
  copy { print }
' CHANGELOG.md > "$NOTES"
grep -Eq '^[-*] ' "$NOTES" \
  || fail "The $VERSION_NUMBER changelog section has no release notes." 65
grep -Fq "[${VERSION_NUMBER}]:" CHANGELOG.md \
  || fail "CHANGELOG.md has no comparison link for $VERSION_NUMBER." 65

EXISTING_TAG_SHA="$(git rev-parse "${VERSION}^{commit}" 2>/dev/null || true)"
if [[ -n "$EXISTING_TAG_SHA" && "$EXISTING_TAG_SHA" != "$LOCAL_SHA" ]]; then
  fail "$VERSION already points to '$EXISTING_TAG_SHA', not '$LOCAL_SHA'." 65
fi
if [[ -z "$EXISTING_TAG_SHA" ]]; then
  LATEST_VERSION="$(git tag --list 'v0.*.0-beta.*' --sort=-version:refname | head -n 1)"
  [[ "$LATEST_VERSION" =~ ^v0\.([1-9][0-9]*)\.0-beta\.([1-9][0-9]*)$ ]] \
    || fail "No valid previous beta tag is available." 65
  LATEST_MINOR="${BASH_REMATCH[1]}"
  LATEST_BETA="${BASH_REMATCH[2]}"
  SAME_TRACK=$((TARGET_MINOR == LATEST_MINOR && TARGET_BETA == LATEST_BETA + 1))
  NEXT_TRACK=$((TARGET_MINOR == LATEST_MINOR + 1 && TARGET_BETA == 1))
  ((SAME_TRACK || NEXT_TRACK)) \
    || fail "$VERSION is not the next beta after $LATEST_VERSION." 65
fi

gh auth status >/dev/null
scripts/check.sh

echo "→ Releasing ${VERSION} (${LOCAL_SHA}) to ${DEPLOY_USER}@${DEPLOY_HOST}:${APP_DIR}"
ssh -i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes "${DEPLOY_USER}@${DEPLOY_HOST}" \
  "cd '${APP_DIR}' && git pull --ff-only && release=\$(git rev-parse HEAD) && \
   test \"\$release\" = '${LOCAL_SHA}' && \
   sudo install -d -o root -g root -m 0755 /usr/local/libexec && \
   sudo install -o root -g root -m 0755 scripts/check_backup_freshness.sh \
     /usr/local/libexec/apachas-check-backup-freshness && \
   sudo APP_VERSION='${VERSION}' APP_RELEASE=\"\$release\" docker compose up -d --wait"

DEPLOYED_SHA="$(ssh -i "$DEPLOY_SSH_KEY" -o IdentitiesOnly=yes \
  "${DEPLOY_USER}@${DEPLOY_HOST}" "cd '${APP_DIR}' && git rev-parse HEAD")"
[[ "$DEPLOYED_SHA" == "$LOCAL_SHA" ]] \
  || fail "Server deployed '$DEPLOYED_SHA', expected '$LOCAL_SHA'."

echo "→ Checking ${PUBLIC_URL}"
curl -fsS -o /dev/null --retry 3 --retry-delay 2 "$PUBLIC_URL"
HEALTH="$(curl -fsS --retry 3 --retry-delay 2 "${PUBLIC_URL}/api/health")"
IFS=$'\t' read -r HEALTH_VERSION HEALTH_RELEASE < <(
  printf '%s' "$HEALTH" | node -e '
    const input = require("node:fs").readFileSync(0, "utf8");
    const health = JSON.parse(input);
    process.stdout.write(String(health.version || "") + "\t" +
      String(health.release || "") + "\n");
  '
)
[[ "$HEALTH_RELEASE" == "$DEPLOYED_SHA" ]] \
  || fail "Health reports release '$HEALTH_RELEASE', expected '$DEPLOYED_SHA'."
[[ "$HEALTH_VERSION" == "$VERSION" ]] \
  || fail "Health reports version '$HEALTH_VERSION', expected '$VERSION'."

if [[ -z "$EXISTING_TAG_SHA" ]]; then
  git tag "$VERSION" "$DEPLOYED_SHA"
fi
if ! git ls-remote --exit-code --tags origin "refs/tags/${VERSION}" >/dev/null 2>&1; then
  git push origin "$VERSION"
fi
REMOTE_TAG_SHA="$(git ls-remote --tags --refs origin "refs/tags/${VERSION}" | awk '{print $1}')"
[[ "$REMOTE_TAG_SHA" == "$DEPLOYED_SHA" ]] \
  || fail "Remote tag $VERSION points to '$REMOTE_TAG_SHA', expected '$DEPLOYED_SHA'."

RELEASE_TAG="$(gh release view "$VERSION" --json tagName --jq .tagName 2>/dev/null || true)"
if [[ -z "$RELEASE_TAG" ]]; then
  gh release create "$VERSION" --verify-tag --prerelease \
    --title "A Pachas $VERSION" --notes-file "$NOTES"
fi
RELEASE_TAG="$(gh release view "$VERSION" --json tagName --jq .tagName)"
[[ "$RELEASE_TAG" == "$VERSION" ]] \
  || fail "GitHub Release uses tag '$RELEASE_TAG', expected '$VERSION'."

echo "✔ ${PUBLIC_URL} runs ${VERSION} on release ${DEPLOYED_SHA}"
