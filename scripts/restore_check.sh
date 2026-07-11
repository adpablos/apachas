#!/usr/bin/env bash
# Verify that an encrypted A Pachas backup can be safely restored.
set -euo pipefail

umask 077

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/restore_check.sh <encrypted-backup.tar.gz.age> <age-identity-file>

Verifies the companion manifest, decrypts into a temporary directory, rejects
unsafe archive entries, and validates every party document. It never writes to
the live data volume and removes all temporary plaintext on exit.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -ne 2 ]]; then
  usage
  exit 64
fi

BACKUP_PATH="$1"
IDENTITY_FILE="$2"
MANIFEST_PATH="${APACHAS_BACKUP_MANIFEST:-${BACKUP_PATH%.tar.gz.age}.manifest.json}"
tmpdir=""

fail() {
  printf 'Restore check failed: %s\n' "$1" >&2
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

validate_party_document() {
  local document="$1"
  jq -e '
    def valid_id: type == "string" and test("^[A-Za-z0-9_-]{1,40}$");
    type == "object"
    and (.key | type == "string" and test("^[abcdefghjkmnpqrstuvwxyz23456789]{14}$"))
    and ((has("ownerKey") | not)
      or (.ownerKey | type == "string" and test("^[abcdefghjkmnpqrstuvwxyz23456789]{24}$")))
    and (.rev | type == "number" and . >= 1 and floor == .)
    and (.state | type == "object")
    and (.state.party | type == "object")
    and (.state.party.name | type == "string" and length > 0 and length <= 80)
    and (.state.people | type == "array" and length > 0 and length <= 100
      and all(.[]; type == "object" and (.id | valid_id)
        and (.name | type == "string" and length > 0 and length <= 40)))
    and (.state.items | type == "array" and length <= 500
      and all(.[]; type == "object" and (.id | valid_id)
        and (.name | type == "string" and length > 0 and length <= 80)
        and (.status | . == "pending" or . == "claimed" or . == "bought")))
    and ((.state.transfers // []) | type == "array" and length <= 500)
    and ((.state.tombstones // []) | type == "array" and length <= 500)
    and ((.audit // []) | type == "array")
  ' "$document" >/dev/null
}

secure_cleanup() {
  [[ -n "$tmpdir" && -d "$tmpdir" ]] || return 0
  if command -v shred >/dev/null 2>&1; then
    find "$tmpdir" -type f -exec shred -u -- {} + 2>/dev/null || true
  fi
  rm -rf -- "$tmpdir"
}
trap secure_cleanup EXIT

require_command age
require_command jq
require_command tar
if ! command -v sha256sum >/dev/null 2>&1 \
  && ! command -v shasum >/dev/null 2>&1; then
  fail "sha256sum or shasum is required" 70
fi

[[ -f "$BACKUP_PATH" && -r "$BACKUP_PATH" ]] \
  || fail "backup is not readable: $BACKUP_PATH" 66
[[ -f "$IDENTITY_FILE" && -r "$IDENTITY_FILE" ]] \
  || fail "age identity is not readable: $IDENTITY_FILE" 66
[[ -f "$MANIFEST_PATH" && -r "$MANIFEST_PATH" ]] \
  || fail "companion manifest is not readable: $MANIFEST_PATH" 66

encrypted_size="$(wc -c < "$BACKUP_PATH" | tr -d ' ')"
encrypted_sha256="$(hash_file "$BACKUP_PATH")"
jq -e \
  --arg file "$(basename "$BACKUP_PATH")" \
  --arg sha256 "$encrypted_sha256" \
  --argjson size "$encrypted_size" '
    .formatVersion == 1
    and .encryptedFile == $file
    and .encryptedSha256 == $sha256
    and .encryptedSizeBytes == $size
    and (.activePartyCount | type == "number")
    and (.deletedPartyCount | type == "number")
  ' "$MANIFEST_PATH" >/dev/null \
  || fail "companion manifest does not match the encrypted backup" 65

tmpdir="$(mktemp -d)"
plain_archive="$tmpdir/apachas-data.tar.gz"
restore_dir="$tmpdir/restore"
mkdir "$restore_dir"

age -d -i "$IDENTITY_FILE" -o "$plain_archive" "$BACKUP_PATH"

# Only regular files and directories rooted at apachas-data are accepted.
tar -tzf "$plain_archive" | awk '
  /^\// || /(^|\/)\.\.(\/|$)/ || !/^apachas-data(\/|$)/ { unsafe = 1 }
  END { exit unsafe ? 1 : 0 }
' || fail "archive contains an unsafe path" 65
tar -tvzf "$plain_archive" | awk '
  substr($1, 1, 1) != "-" && substr($1, 1, 1) != "d" { unsafe = 1 }
  END { exit unsafe ? 1 : 0 }
' || fail "archive contains a link or special file" 65

tar -xzf "$plain_archive" -C "$restore_dir" --no-same-owner --no-same-permissions
snapshot_root="$restore_dir/apachas-data"
data_dir="$snapshot_root/data"
trash_dir="$data_dir/.trash"
snapshot_manifest="$snapshot_root/snapshot-manifest.json"

[[ -d "$data_dir" && -d "$trash_dir" ]] \
  || fail "archive is missing its data directories" 65
[[ -f "$snapshot_manifest" ]] \
  || fail "archive is missing its snapshot manifest" 65
jq -e '
  .formatVersion == 1
  and (.createdAt | type == "string")
  and (.activePartyCount | type == "number")
  and (.deletedPartyCount | type == "number")
  and .observabilityKeyIncluded == true
' "$snapshot_manifest" >/dev/null \
  || fail "snapshot manifest is invalid" 65

observability_key="$data_dir/.observability-key"
[[ -f "$observability_key" ]] \
  || fail "archive is missing the observability key" 65
key_size="$(wc -c < "$observability_key" | tr -d ' ')"
[[ "$key_size" -ge 32 ]] || fail "restored observability key is unexpectedly short" 65

while IFS= read -r -d '' document; do
  validate_party_document "$document" \
    || fail "invalid restored party document: $(basename "$document")" 65
done < <(find "$data_dir" -maxdepth 1 -type f -name '*.json' -print0)
while IFS= read -r -d '' document; do
  validate_party_document "$document" \
    || fail "invalid restored deleted-party document: $(basename "$document")" 65
done < <(find "$trash_dir" -maxdepth 1 -type f -name '*.json' -print0)

active_count="$(find "$data_dir" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
deleted_count="$(find "$trash_dir" -maxdepth 1 -type f -name '*.json' | wc -l | tr -d ' ')"
expected_active="$(jq -r '.activePartyCount' "$snapshot_manifest")"
expected_deleted="$(jq -r '.deletedPartyCount' "$snapshot_manifest")"
[[ "$active_count" == "$expected_active" && "$deleted_count" == "$expected_deleted" ]] \
  || fail "restored document counts do not match the snapshot manifest" 65

external_active="$(jq -r '.activePartyCount' "$MANIFEST_PATH")"
external_deleted="$(jq -r '.deletedPartyCount' "$MANIFEST_PATH")"
[[ "$active_count" == "$external_active" && "$deleted_count" == "$external_deleted" ]] \
  || fail "restored document counts do not match the companion manifest" 65

jq -n \
  --arg backup "$(basename "$BACKUP_PATH")" \
  --argjson activePartyCount "$active_count" \
  --argjson deletedPartyCount "$deleted_count" \
  '{
    status: "ok",
    backup: $backup,
    activePartyCount: $activePartyCount,
    deletedPartyCount: $deletedPartyCount,
    observabilityKeyIncluded: true
  }'
