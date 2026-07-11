#!/bin/sh
set -eu

ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

node --check server/api.js
node scripts/update_csp.js --check
bash -n scripts/backup_data.sh scripts/restore_check.sh
node --test tests/*.test.js
