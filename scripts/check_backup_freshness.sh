#!/usr/bin/env bash
# Verify that a recent encrypted backup and its manifest exist, then optionally
# notify a generic heartbeat endpoint. This runs separately from backup creation
# so the hardened backup service itself never receives network access.
set -euo pipefail

BACKUP_DIR="${APACHAS_BACKUP_DIR:-/var/backups/apachas}"
MAX_AGE_HOURS="${APACHAS_BACKUP_MAX_AGE_HOURS:-36}"
HEARTBEAT_URL="${APACHAS_BACKUP_HEARTBEAT_URL:-}"

fail() {
  printf 'Backup freshness check failed: %s\n' "$1" >&2
  exit "${2:-1}"
}

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ && "$MAX_AGE_HOURS" -gt 0 ]] \
  || fail "maximum age must be a positive number of hours" 78
command -v jq >/dev/null 2>&1 || fail "jq is required" 69
[[ -d "$BACKUP_DIR" && -r "$BACKUP_DIR" ]] \
  || fail "backup directory is not readable" 66

newest_manifest=""
newest_mtime=0
while IFS= read -r -d '' manifest; do
  mtime="$(stat -c %Y "$manifest" 2>/dev/null || stat -f %m "$manifest")"
  if (( mtime > newest_mtime )); then
    newest_manifest="$manifest"
    newest_mtime="$mtime"
  fi
done < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'apachas-*.manifest.json' -print0)

[[ -n "$newest_manifest" ]] || fail "no backup manifest exists" 65
encrypted_file="$(jq -er '.encryptedFile | select(type == "string")' "$newest_manifest")" \
  || fail "latest manifest is invalid" 65
encrypted_size="$(jq -er '.encryptedSizeBytes | select(type == "number" and . > 0 and floor == .)' "$newest_manifest")" \
  || fail "latest manifest has no valid encrypted size" 65
encrypted_sha256="$(jq -er '.encryptedSha256 | select(type == "string" and test("^[a-f0-9]{64}$"))' "$newest_manifest")" \
  || fail "latest manifest has no valid encrypted checksum" 65
[[ "$encrypted_file" == "$(basename "$encrypted_file")" ]] \
  || fail "latest manifest has an unsafe encrypted filename" 65
[[ -s "$BACKUP_DIR/$encrypted_file" ]] \
  || fail "latest encrypted backup is missing or empty" 65
actual_size="$(wc -c < "$BACKUP_DIR/$encrypted_file" | tr -d ' ')"
[[ "$actual_size" == "$encrypted_size" ]] \
  || fail "latest encrypted backup size does not match its manifest" 65
actual_sha256="$(hash_file "$BACKUP_DIR/$encrypted_file")"
[[ "$actual_sha256" == "$encrypted_sha256" ]] \
  || fail "latest encrypted backup checksum does not match its manifest" 65

age_seconds="$(( $(date +%s) - newest_mtime ))"
(( age_seconds <= MAX_AGE_HOURS * 3600 )) \
  || fail "latest complete backup is older than ${MAX_AGE_HOURS} hours" 75

if [[ -n "$HEARTBEAT_URL" ]]; then
  [[ "$HEARTBEAT_URL" =~ ^https://[A-Za-z0-9._~:/?#@!\$\&\(\)\*+,\;=%-]+$ ]] \
    || fail "heartbeat URL must be a valid HTTPS URL" 78
  printf 'url = "%s"\n' "$HEARTBEAT_URL" | \
    curl --config - --fail --silent --show-error --max-time 10 --retry 1 \
      --output /dev/null \
    || fail "heartbeat request failed" 69
fi

printf 'Backup is fresh (%s hours old).\n' "$(( age_seconds / 3600 ))"
