#!/usr/bin/env bash
# Create an encrypted snapshot of the A Pachas Docker data volume.
set -euo pipefail

umask 077

DATA_DIR="${APACHAS_DATA_DIR:-/var/lib/docker/volumes/apachas_api-data/_data}"
BACKUP_DIR="${APACHAS_BACKUP_DIR:-/var/backups/apachas}"
RECIPIENTS_FILE="${APACHAS_BACKUP_RECIPIENTS_FILE:-/etc/apachas/backup-recipients.txt}"
RETENTION_DAYS="${APACHAS_BACKUP_RETENTION_DAYS:-30}"

plain_archive=""
snapshot_dir=""
encrypted_tmp=""
manifest_tmp=""
created_encrypted=""
created_manifest=""
backup_complete=false

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/backup_data.sh

Creates an age-encrypted backup of the A Pachas data volume. Configure age
public recipients in /etc/apachas/backup-recipients.txt. Never put an age
identity (private key) on the application server or in this repository.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 0 ]]; then
  usage
  exit 64
fi

fail() {
  printf 'Backup failed: %s\n' "$1" >&2
  exit "${2:-1}"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$1 is required" 70
}

hash_file() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path" | awk '{print $1}'
  else
    shasum -a 256 "$path" | awk '{print $1}'
  fi
}

secure_remove() {
  local path="$1"
  [[ -e "$path" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    if [[ -d "$path" ]]; then
      find "$path" -type f -exec shred -u -- {} + 2>/dev/null || true
      rm -rf -- "$path"
    else
      shred -u -- "$path" 2>/dev/null || rm -f -- "$path"
    fi
  else
    rm -rf -- "$path"
  fi
}

cleanup() {
  [[ -z "$plain_archive" ]] || secure_remove "$plain_archive"
  [[ -z "$snapshot_dir" ]] || secure_remove "$snapshot_dir"
  [[ -z "$encrypted_tmp" ]] || rm -f -- "$encrypted_tmp"
  [[ -z "$manifest_tmp" ]] || rm -f -- "$manifest_tmp"
  if [[ "$backup_complete" != true ]]; then
    [[ -z "$created_encrypted" ]] || rm -f -- "$created_encrypted"
    [[ -z "$created_manifest" ]] || rm -f -- "$created_manifest"
  fi
}
trap cleanup EXIT

copy_json_files() {
  local source_dir="$1"
  local destination_dir="$2"
  local source target

  [[ -d "$source_dir" ]] || return 0
  while IFS= read -r -d '' source; do
    target="$destination_dir/$(basename "$source")"
    if ! cp -- "$source" "$target"; then
      # A concurrent soft delete or restore can atomically move a document
      # between the active and trash directories. Missing files are safe to
      # skip; every file that is captured is validated independently below.
      [[ ! -e "$source" ]] && continue
      fail "could not snapshot $source" 74
    fi
    chmod 0600 "$target"
    jq -e 'type == "object"' "$target" >/dev/null \
      || fail "invalid party document: $source" 65
  done < <(find "$source_dir" -maxdepth 1 -type f -name '*.json' -print0)
}

data_inventory() {
  local data_root="$1"
  local source digest
  {
    while IFS= read -r -d '' source; do
      digest="$(hash_file "$source" 2>/dev/null)" || continue
      printf 'data/%s\t%s\n' "$(basename "$source")" "$digest"
    done < <(find "$data_root" -maxdepth 1 -type f \
      \( -name '*.json' -o -name '.observability-key' \) -print0)
    if [[ -d "$data_root/.trash" ]]; then
      while IFS= read -r -d '' source; do
        digest="$(hash_file "$source" 2>/dev/null)" || continue
        printf 'data/.trash/%s\t%s\n' "$(basename "$source")" "$digest"
      done < <(find "$data_root/.trash" -maxdepth 1 -type f -name '*.json' -print0)
    fi
  } | LC_ALL=C sort
}

require_command age
require_command flock
require_command jq
require_command tar
if ! command -v sha256sum >/dev/null 2>&1 \
  && ! command -v shasum >/dev/null 2>&1; then
  fail "sha256sum or shasum is required" 70
fi

[[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$RETENTION_DAYS" -gt 0 ]] \
  || fail "retention days must be a positive integer" 78
[[ -d "$DATA_DIR" && -r "$DATA_DIR" ]] \
  || fail "data directory is not readable: $DATA_DIR" 66
[[ -s "$RECIPIENTS_FILE" && -r "$RECIPIENTS_FILE" ]] \
  || fail "age recipients file is missing or empty: $RECIPIENTS_FILE" 78

# Reject private identities and malformed non-comment lines. This file must
# contain public recipients only, one per line.
awk '
  /^[[:space:]]*($|#)/ { next }
  /^[[:space:]]*age1[[:alnum:]]+[[:space:]]*$/ { found = 1; next }
  { invalid = 1 }
  END { exit invalid ? 2 : (found ? 0 : 1) }
' "$RECIPIENTS_FILE" || fail "age recipients file contains no valid public recipient" 78

mkdir -p "$BACKUP_DIR/tmp"
exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || fail "another backup is already running" 75

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
base_name="apachas-${timestamp}"
encrypted_backup="$BACKUP_DIR/${base_name}.tar.gz.age"
manifest="$BACKUP_DIR/${base_name}.manifest.json"
[[ ! -e "$encrypted_backup" && ! -e "$manifest" ]] \
  || fail "backup already exists for timestamp $timestamp" 73

snapshot_dir="$(mktemp -d "$BACKUP_DIR/tmp/${base_name}.snapshot.XXXXXX")"
snapshot_root="$snapshot_dir/apachas-data"
observability_key="$DATA_DIR/.observability-key"
[[ -f "$observability_key" && -r "$observability_key" ]] \
  || fail "observability key is not readable: $observability_key" 66
key_size="$(wc -c < "$observability_key" | tr -d ' ')"
[[ "$key_size" -ge 32 ]] || fail "observability key is unexpectedly short" 65

# Party writes and soft deletes use atomic renames, but they can still move a
# file while this script is walking the volume. Capture again unless the copied
# inventory exactly matches the current source, preventing missed or duplicate
# parties in the archive.
snapshot_stable=false
for attempt in 1 2 3; do
  secure_remove "$snapshot_root"
  mkdir -p "$snapshot_root/data/.trash"
  copy_json_files "$DATA_DIR" "$snapshot_root/data"
  copy_json_files "$DATA_DIR/.trash" "$snapshot_root/data/.trash"
  cp -- "$observability_key" "$snapshot_root/data/.observability-key"
  chmod 0600 "$snapshot_root/data/.observability-key"
  captured_inventory="$(data_inventory "$snapshot_root/data")"
  source_inventory="$(data_inventory "$DATA_DIR")"
  if [[ "$captured_inventory" == "$source_inventory" ]]; then
    snapshot_stable=true
    break
  fi
done
[[ "$snapshot_stable" == true ]] \
  || fail "data kept changing during $attempt snapshot attempts" 75

active_count="$(find "$snapshot_root/data" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
deleted_count="$(find "$snapshot_root/data/.trash" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"

jq -n \
  --arg createdAt "$created_at" \
  --argjson activePartyCount "$active_count" \
  --argjson deletedPartyCount "$deleted_count" \
  '{
    formatVersion: 1,
    createdAt: $createdAt,
    activePartyCount: $activePartyCount,
    deletedPartyCount: $deletedPartyCount,
    observabilityKeyIncluded: true
  }' > "$snapshot_root/snapshot-manifest.json"

plain_archive="$(mktemp "$BACKUP_DIR/tmp/${base_name}.archive.XXXXXX.tar.gz")"
tar -C "$snapshot_dir" -czf "$plain_archive" apachas-data

encrypted_tmp="$(mktemp "$BACKUP_DIR/tmp/${base_name}.encrypted.XXXXXX.age")"
age -R "$RECIPIENTS_FILE" -o "$encrypted_tmp" "$plain_archive"
chmod 0600 "$encrypted_tmp"
mv -- "$encrypted_tmp" "$encrypted_backup"
encrypted_tmp=""
created_encrypted="$encrypted_backup"

encrypted_size="$(wc -c < "$encrypted_backup" | tr -d ' ')"
encrypted_sha256="$(hash_file "$encrypted_backup")"
manifest_tmp="$(mktemp "$BACKUP_DIR/tmp/${base_name}.manifest.XXXXXX.json")"
jq -n \
  --arg createdAt "$created_at" \
  --arg encryptedFile "$(basename "$encrypted_backup")" \
  --arg encryptedSha256 "$encrypted_sha256" \
  --argjson encryptedSizeBytes "$encrypted_size" \
  --argjson activePartyCount "$active_count" \
  --argjson deletedPartyCount "$deleted_count" \
  '{
    formatVersion: 1,
    createdAt: $createdAt,
    encryptedFile: $encryptedFile,
    encryptedSizeBytes: $encryptedSizeBytes,
    encryptedSha256: $encryptedSha256,
    activePartyCount: $activePartyCount,
    deletedPartyCount: $deletedPartyCount
  }' > "$manifest_tmp"
chmod 0600 "$manifest_tmp"
mv -- "$manifest_tmp" "$manifest"
manifest_tmp=""
created_manifest="$manifest"
backup_complete=true

find "$BACKUP_DIR" -maxdepth 1 -type f -name 'apachas-*.tar.gz.age' \
  -mmin "+$((RETENTION_DAYS * 1440))" -delete
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'apachas-*.manifest.json' \
  -mmin "+$((RETENTION_DAYS * 1440))" -delete

printf '%s\n' "$encrypted_backup"
