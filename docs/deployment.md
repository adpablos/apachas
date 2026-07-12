# Deployment

A Pachas is served from the Hetzner server `treasure-map-prod-01`, the same
server that hosts the World Cup pool. SSH is only available through the tailnet
at `100.83.154.97`, with user `adpablos` and key
`~/.ssh/treasure_map_prod_github_actions_ed25519`; the personal key is not
authorized on that server.

## Architecture

One isolated Docker Compose project, `apachas`, with three containers:

```txt
Internet ── Cloudflare ── tunnel "apachas" ── cloudflared ── nginx (web)
                                                               ├─ serves public/
https://apachas.alexdepablos.es                               └─ /api/ → api
                                                                  (node,
                                                                   shared
                                                                   parties)
```

- `web`: nginx serves `public/` read-only and proxies `/api/` to the `api`
  container. Config lives in `deployment/nginx/default.conf`. It is also
  exposed on `127.0.0.1:3200` on the server for operator smoke tests.
- `api`: `server/api.js` on `node:22-alpine`, with no `npm install` and no
  runtime dependencies. It stores one JSON document per shared party in the
  `api-data` volume. If it goes down, static serving stays up and the last
  confirmed party remains readable, but shared edits and invitations stop until
  the API returns; `web` only waits for `api` to start, not for it to be healthy.
- `cloudflared`: this app's own tunnel, following the same pattern as the World
  Cup production and staging stacks: one tunnel per stack, zero coupling
  between apps.

There is no build step and no account/application credential required at
startup. Party data lives in the `api-data` volume. It is lost only with
`docker compose down -v`; untouched
parties are automatically purged after eight months. The only externally
provisioned secret required by the running stack is the tunnel credential,
which lives outside the repository. Backup decryption uses a private `age`
identity held off-server on the operator Mac and in 1Password; the server
receives only its public recipient. A randomly generated observability key lives
inside the data volume and only produces one-way party/device references for
correlation; it is never returned or logged.

## Server Paths

These are the canonical deployment paths for A Pachas. Changing them is a server migration, not a cosmetic repo change.

| What                       | Where                              |
| -------------------------- | ---------------------------------- |
| Deployment clone           | `/opt/apachas`                     |
| Tunnel config/credentials  | `/etc/apachas/cloudflared/`        |
| Backup public recipients   | `/etc/apachas/backup-recipients.txt` |
| Encrypted backup artifacts | `/var/backups/apachas/`            |
| Optional observability credentials | `/etc/apachas/observability.env` |
| Optional backup heartbeat | `/etc/apachas/backup-monitor.env` |
| Local smoke port           | `127.0.0.1:3200`                   |
| Compose project            | `apachas`                          |

## Normal Deployment

Commit and push to `main`, then run from the Mac:

```bash
scripts/deploy.sh
```

The script runs `git pull --ff-only`, injects the exact git SHA as
`APP_RELEASE`, and runs `docker compose up -d --wait`. The release change
recreates `api` and `web`, which is required for mounted API/nginx changes. It
then verifies the public web and checks that `/api/health` reports the exact
deployed SHA. Docker Compose 2.24 or newer is required for the optional
`env_file.required` syntax; production was verified on 2.40.3 on 2026-07-12.

## Versioning and Release Recording

A Pachas keeps three deliberately separate identifiers:

| Identifier | Source | Changes when |
| --- | --- | --- |
| Product version | Git tag such as `v0.1.0-beta.1` | A release is recorded |
| Deployed release | `APP_RELEASE`, always the full Git SHA | Production is deployed |
| Data contract | `STATE_VERSION` in frontend and API | Persisted state changes |

The first family-and-friends beta is `v0.1.0-beta.1`. While the product remains
in beta, versions use `0.MINOR.0-beta.N`: small fixes and improvements increment
`N`, while a substantial new capability increments `MINOR` and resets the
suffix to `beta.1`. Do not add a second version file or replace `APP_RELEASE`
with SemVer: the tag is the human version and the SHA remains the precise
diagnostic and rollback identity.

For every pull request, add one concise bullet under `Unreleased` in
`CHANGELOG.md` when behavior, persisted data, security, privacy, deployment, or
recovery changes. Pure refactors and test-only changes need no entry unless they
alter one of those contracts.

To record a release:

1. Move the `Unreleased` bullets into a dated version section and restore an
   empty `Unreleased` section.
2. Merge only after review and CI are green, then deploy with `scripts/deploy.sh`.
3. Read the exact deployed SHA from `/api/health` and tag that commit, never an
   unverified local commit.
4. Push the tag and create a GitHub Release marked as a prerelease, using the
   matching changelog section as its notes.

```bash
set -euo pipefail
scripts/check.sh
version="v0.1.0-beta.1"
git fetch origin main --tags
expected_sha="$(git rev-parse origin/main)"

scripts/deploy.sh
health="$(curl -fsS https://apachas.alexdepablos.es/api/health)"
deployed_sha="$(printf '%s' "$health" | sed -n 's/.*"release":"\([^"]*\)".*/\1/p')"
test "$deployed_sha" = "$expected_sha"
git cat-file -e "${deployed_sha}^{commit}"

notes="$(mktemp)"
awk -v heading="## [${version#v}]" '
  index($0, heading " - ") == 1 { copy = 1; next }
  copy && /^## \[/ { exit }
  copy { print }
' CHANGELOG.md > "$notes"
test -s "$notes"

git tag "$version" "$deployed_sha"
git push origin "$version"
gh release create "$version" --verify-tag --prerelease \
  --title "A Pachas $version" --notes-file "$notes"
rm -f "$notes"
```

A version section may be corrected until its tag and GitHub Release are
published. From that point it is frozen: never move or reuse the tag, and
correct the release with a new SemVer version and changelog entry.

Equivalent manual flow on the server:

```bash
cd /opt/apachas
git pull --ff-only
release="$(git rev-parse HEAD)"
sudo APP_RELEASE="$release" docker compose up -d --wait
curl -fsS http://127.0.0.1:3200/ >/dev/null && echo OK
curl -fsS http://127.0.0.1:3200/api/health >/dev/null && echo API OK
```

## Initial Setup

Completed on 2026-07-05 with tunnel `apachas`, id
`2abb0680-613f-4304-9835-80e2bcf642fd`. This is documented so the setup can be
recreated if needed.

Important boundary: the `cloudflared` CLI and the Cloudflare account
`cert.pem` live on the Mac under `~/.cloudflared/`, not on the server. Tunnels
are created from the Mac; only the tunnel credentials travel to the server.
This is the same pattern used by the World Cup pool tunnels.

1. From the Mac, create the tunnel and DNS route:

   ```bash
   cloudflared tunnel create apachas
   cloudflared tunnel route dns apachas apachas.alexdepablos.es
   ```

   `create` prints the tunnel id and stores credentials at
   `~/.cloudflared/<tunnel-id>.json`.

2. From the Mac, upload credentials and config using the same permission
   pattern as the World Cup pool: `root:adpablos`, files `0640`, directories
   `0750`.

   ```bash
   TID=<tunnel-id>
   sed "s/<tunnel-id>/$TID/g" deployment/cloudflare/config.yml.example > /tmp/apachas-config.yml
   scp -i ~/.ssh/treasure_map_prod_github_actions_ed25519 -o IdentitiesOnly=yes \
     /tmp/apachas-config.yml ~/.cloudflared/$TID.json adpablos@100.83.154.97:/tmp/
   ```

   Then on the server:

   ```bash
   sudo mkdir -p /etc/apachas/cloudflared
   sudo install -o root -g adpablos -m 0640 /tmp/apachas-config.yml /etc/apachas/cloudflared/config.yml
   sudo install -o root -g adpablos -m 0640 /tmp/$TID.json /etc/apachas/cloudflared/$TID.json
   sudo chown root:adpablos /etc/apachas /etc/apachas/cloudflared
   sudo chmod 750 /etc/apachas /etc/apachas/cloudflared
   rm /tmp/apachas-config.yml /tmp/$TID.json
   ```

3. On the server, clone the repo:

   ```bash
   sudo git clone https://github.com/adpablos/apachas.git /opt/apachas
   sudo chown -R adpablos:adpablos /opt/apachas
   ```

4. Start and verify:

   ```bash
   cd /opt/apachas
   release="$(git rev-parse HEAD)"
   sudo APP_RELEASE="$release" docker compose up -d --wait
   curl -fsS https://apachas.alexdepablos.es >/dev/null && echo OK
   ```

## Operations

Status and logs:

```bash
sudo docker compose -p apachas ps
sudo docker compose -p apachas logs -f api
sudo docker compose -p apachas logs -f cloudflared
sudo docker compose -p apachas logs -f web
```

All three containers rotate `json-file` logs at 10 MB with five files. API and
nginx API-access lines are structured JSON. Useful privacy-safe queries:

```bash
# Failures and sanitized exceptions.
sudo docker compose -p apachas logs --no-log-prefix api \
  | jq -Rr 'fromjson? | select(.level == "error" or .event == "client_event")'

# Five-minute route/status/latency summaries.
sudo docker compose -p apachas logs --no-log-prefix api \
  | jq -Rr 'fromjson? | select(.event == "metrics_snapshot")'

# nginx-only upstream failures such as 502/504, without request URLs or IPs.
sudo docker compose -p apachas logs --no-log-prefix web \
  | jq -Rr 'fromjson? | select(.status >= 500)'
```

`GET /api/live` is liveness. `GET /api/health` is readiness: it checks that the
data volume is readable/writable and has working capacity, then reports the
release SHA. The scheduled `.github/workflows/uptime.yml` check calls the public
web and readiness endpoint every 15 minutes; a failed run is the external alert.
GitHub notification delivery still depends on the repository owner's Actions
notification settings.

Audit events live inside each party document, are server-derived, capped at 200
events and 256 KB, and are deleted or expired with the party. Client error telemetry contains only
fixed codes, safe route labels, status/request IDs, and one-way party/device
references. It never includes names, amounts, concepts, state, bodies, full URLs,
IP addresses, or URL fragments.

### Optional remote observability

Remote observability is disabled unless credentials are provisioned. Local JSON
logs, health endpoints, metrics snapshots, and backups remain the source of
truth and continue working when either provider is unavailable.

The API supports two independent server-side projections:

- **Better Stack EU** receives an explicit allowlist of already-sanitized JSON
  fields. Every log is written locally first. Delivery uses a bounded queue and
  a two-second timeout, without delaying an application request. Raw stacks stay
  local; the remote copy receives only a one-way stack reference for grouping.
- **PostHog EU** receives only the product events listed below. The API uses the
  HMAC party reference as `distinct_id` and always sends
  `$process_person_profile: false`. Bounded retries reuse a content-free
  `$insert_id` so a delayed response cannot double-count an event. There is no
  browser SDK, autocapture, cookie, session replay, URL capture, or person profile.

| Product event | Source | Meaning |
| --- | --- | --- |
| `party_created` | Server | A valid party document was created. |
| `collaboration_started` | Server | An accepted write arrived from the first second party-scoped device. |
| `first_expense_recorded` | Server | The party accepted its first bought item. |
| `first_transfer_completed` | Server | The party accepted its first completed transfer. |
| `party_opened_write`, `party_opened_read` | Client allowlist | A live party opened in the corresponding capability mode. |
| `invite_share_intent`, `accounts_share_intent` | Client allowlist | The native share/copy flow was opened. |
| `support_opened`, `accounts_viewed`, `feedback_opened` | Client allowlist | Support, accounts, or feedback was opened. |

Every event is also recorded in local structured logs as `product_event` before
remote delivery, so a provider gap can be audited or backfilled.
Client-originated events are directional product signals, not
billing or business truth: a caller can submit an allowlisted event without an
account. Server lifecycle events are derived only after an accepted write.

Provision one root-readable environment file on the server:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/apachas/observability.env
sudoedit /etc/apachas/observability.env
```

```dotenv
BETTER_STACK_SOURCE_TOKEN=<logs-source-token>
BETTER_STACK_INGESTING_URL=<source-ingesting-url>
POSTHOG_API_KEY=<project-api-key>
POSTHOG_HOST=https://eu.i.posthog.com
```

Use a Better Stack logs source in the EU region and a PostHog EU project. These
are ingestion credentials, not personal or management API tokens. Store their
canonical recovery copy in 1Password vault `Private`, Secure Note
`A Pachas observability providers`, item ID
`wyqighwbupu3srdzj2myqvancu`. The note also records the provider workspace and
resource IDs plus their admin URLs.
Never put tokens in GitHub, Compose, shell history, or this repository.

Set provider retention to no more than 30 days for operational logs and 12
months for content-free product events; a plan may retain them for less time.
The same limits apply to dashboards and exports. Do not enable recordings,
autocapture, surveys, feature flags, or person profiles in PostHog for this app.

Recommended provider configuration:

1. Monitor `/` and `/api/health` externally; alert after two consecutive
   failures.
2. Alert on any `request` with `status >= 500`, any `request_exception`, and a
   sustained increase in `client_event` or sync failures.
3. Dashboard the five-minute `metrics_snapshot` fields for status, latency,
   active pseudonymous parties/devices, storage readiness, and free bytes.
4. Build activation (`party_created` → `collaboration_started` →
   `first_expense_recorded`) and settlement (`first_expense_recorded` →
   `first_transfer_completed`) funnels in PostHog. Treat small beta counts as
   directional.

After saving the environment file, redeploy the API and verify that one
`api_started` log and a deliberately created test party reach the EU projects.
Inspect the provider payloads to confirm that no party ID, device ID, name,
amount, URL, IP address, or state appears.

General traffic, party creation, and client events have separate configurable
rate buckets. A rejected request returns `429` plus `Retry-After`. Defaults are
defined in `server/api.js`; overrides use `RATE_MAX`, `RATE_WINDOW_MS`,
`CREATE_RATE_MAX`, `CREATE_RATE_WINDOW_MS`, `EVENT_RATE_MAX`, and
`EVENT_RATE_WINDOW_MS` on the `api` service.

The Content Security Policy is generated from the real inline style and script
blocks in `public/index.html`. After changing either block, run:

```bash
node scripts/update_csp.js
scripts/check.sh
```

CI fails when the generated header is stale. `security-headers.conf` permits
only the app origin plus Google Fonts, blocks framing and plugins, and keeps
inline JavaScript restricted to the generated SHA-256 hash.

## External Feedback Board

`FEEDBACK_URL` in `public/index.html` is the single integration point for the
target Featurebase board. A Pachas uses a normal external link only: there is no
Featurebase SDK, widget, iframe, runtime credential, or cookie in the app. The
link has no query string or fragment, sends no referrer, and receives no party
or identity context from A Pachas. Featurebase still receives the ordinary
network, browser, cookie, or account metadata of that separate visit. Before
opening it, the UI names Featurebase and tells people not to enter names,
amounts, or party links.

The content-free `usage.feedback_opened` code is sent separately to A Pachas' own
`POST /api/events` endpoint. Changing providers requires updating `FEEDBACK_URL`,
the visible provider name, every provider reference in `docs/product.md`,
`docs/design.md`, and this runbook, plus the provider-specific assertions in
`tests/browser-core.test.js`; then refresh the CSP hash and run
`scripts/check.sh`.

The Featurebase workspace is provisioned separately from deployment. Before
enabling the CTA for a release, verify that `FEEDBACK_URL` resolves and configure
the public categories `Problemas` and `Ideas`, guest posting/voting, moderation,
and Spanish copy in Featurebase. Votes inform product prioritization; they do not
automatically reorder work or override security, correctness, or data-loss
issues.

## Encrypted Backups

`scripts/backup_data.sh` creates a stable snapshot of active parties, the
seven-day soft-delete area, and `.observability-key`; validates every captured
JSON document; encrypts the archive with public `age` recipients; emits a
content-free size/hash/count manifest; and keeps 30 days. The server must never
hold the private age identity.

### Recovery Identity

The recovery identity has two managed copies. Repository documentation records
only the 1Password locator, never the private identity itself:

| Purpose | Location |
| --- | --- |
| Working copy on the operator Mac | `~/.config/age/apachas-backup-identity.txt` |
| Canonical recovery copy | 1Password vault `Private`, Secure Note `A Pachas backup recovery identity`, item ID `yha7fpblpr3ostz34eggg2avza` |

Locate the 1Password record by its exact title or item ID. If the Mac working
copy is lost, restore the Secure Note contents to the path above and run
`chmod 600 ~/.config/age/apachas-backup-identity.txt` before using the restore
checker. Never place the identity in this repository, on the application
server, in shell history, or in operational logs.

One-time setup:

1. On the Mac, create and protect the recovery identity, then derive its public
   recipient:

   ```bash
   mkdir -p ~/.config/age
   age-keygen -o ~/.config/age/apachas-backup-identity.txt
   chmod 600 ~/.config/age/apachas-backup-identity.txt
   age-keygen -y ~/.config/age/apachas-backup-identity.txt \
     > /tmp/apachas-backup-recipient.txt
   scp -i ~/.ssh/treasure_map_prod_github_actions_ed25519 -o IdentitiesOnly=yes \
     /tmp/apachas-backup-recipient.txt adpablos@100.83.154.97:/tmp/
   ```

2. On the server, install the public recipient and timer:

   ```bash
   sudo apt-get install -y age jq
   sudo install -o root -g root -m 0644 /tmp/apachas-backup-recipient.txt \
     /etc/apachas/backup-recipients.txt
   sudo install -o root -g root -m 0644 \
     /opt/apachas/deployment/systemd/apachas-backup.service \
     /opt/apachas/deployment/systemd/apachas-backup.timer \
     /etc/systemd/system/
   sudo mkdir -p -m 0700 /var/backups/apachas
   sudo systemctl daemon-reload
   sudo systemctl enable --now apachas-backup.timer
   sudo systemctl start apachas-backup.service
   sudo systemctl status apachas-backup.service --no-pager
   systemctl list-timers apachas-backup.timer
   ```

The timer runs daily with a randomized delay. Its service is read-only outside
the backup directory and cannot access the network. The hardened unit requires
output at `/var/backups/apachas`; `/etc/apachas/backup.env` may adjust retention.
Any path override supported by the standalone script also requires a matching
systemd `ReadOnlyPaths` or `ReadWritePaths` drop-in.

### Backup freshness heartbeat

The optional freshness monitor is deliberately separate from backup creation.
The backup unit keeps `RestrictAddressFamilies=AF_UNIX` and therefore no network
access. The monitor executes a root-owned installed copy rather than the deploy
checkout. Its namespace hides `/etc/apachas`, `/opt/apachas`, and Docker data;
it can read the encrypted backup directory but cannot read the application data
volume or any decryption key.

Create a heartbeat monitor in Better Stack with an hourly expected interval and
a 36-hour grace period, then copy its HTTPS ping URL to a root-only environment
file:

```bash
sudo install -o root -g root -m 0600 /dev/null /etc/apachas/backup-monitor.env
sudoedit /etc/apachas/backup-monitor.env
```

```dotenv
APACHAS_BACKUP_MAX_AGE_HOURS=36
APACHAS_BACKUP_HEARTBEAT_URL=<https-heartbeat-url>
```

Install a root-owned copy of the checker outside the deploy checkout, then
install and test the independent monitor:

```bash
sudo install -d -o root -g root -m 0755 /usr/local/libexec
sudo install -o root -g root -m 0755 \
  /opt/apachas/scripts/check_backup_freshness.sh \
  /usr/local/libexec/apachas-check-backup-freshness
sudo install -o root -g root -m 0644 \
  /opt/apachas/deployment/systemd/apachas-backup-monitor.service \
  /opt/apachas/deployment/systemd/apachas-backup-monitor.timer \
  /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now apachas-backup-monitor.timer
sudo systemctl start apachas-backup-monitor.service
sudo systemctl status apachas-backup-monitor.service --no-pager
systemctl list-timers apachas-backup-monitor.timer
```

After this first-time unit installation, `scripts/deploy.sh` refreshes the
root-owned checker on every normal deployment before restarting the app stack.

The hourly check pings only when the newest manifest is recent and its named
encrypted artifact matches the recorded size and SHA-256. A missing, corrupt,
or stale backup exits non-zero and withholds the heartbeat. Configure Better Stack to
alert by email immediately after the 36-hour grace period. Store the heartbeat
URL in the same 1Password observability item as the provider ingestion keys.

Backups on the same host protect against application mistakes, not host or disk
loss. A beta-readiness gate is to copy the encrypted `.age` file and companion
manifest off-host after every run, or mount separately managed storage at the
unit's fixed `/var/backups/apachas` path. Only encrypted artifacts may leave the
server.

Non-destructive restore drill from the Mac after copying both artifacts locally:

```bash
scripts/restore_check.sh \
  /secure/offsite/apachas-YYYYMMDDTHHMMSSZ.tar.gz.age \
  ~/.config/age/apachas-backup-identity.txt
```

The checker validates the companion hash and size, rejects unsafe archive
entries, decrypts only into a temporary `0700` directory, validates the key,
the minimum persisted-party contract for every JSON document, and party counts,
then removes all plaintext. Run this after initial setup and at least monthly.
An actual production restore is a separate incident operation: first preserve
the current volume, stop only the `apachas` API, restore the verified
`apachas-data/data/` tree, restart that API, and run local plus public health
checks. Never touch `current` or `staging`.

Rollback. Content is the repo, so rollback is git:

```bash
cd /opt/apachas
git log --oneline -5          # pick the known-good commit
git reset --hard <commit>     # or revert + push from the Mac, preferred
release="$(git rev-parse HEAD)"
sudo APP_RELEASE="$release" docker compose up -d --wait
```

Shutdown without deleting the tunnel or DNS:

```bash
cd /opt/apachas
sudo docker compose down
```

Full tunnel deletion, if the app is retired someday. Run this from the Mac,
where the account cert lives:

```bash
cloudflared tunnel delete apachas   # after down and DNS deletion in Cloudflare
```

## Guardrails

- The server is shared with the World Cup pool. Compose projects `current`
  (production) and `staging` are off-limits. Do not touch their containers,
  volumes, networks, `/opt/porra-mundial-2026*`, or
  `/etc/porra-mundial-2026/*`.
- Port `3200` is reserved for this app; the World Cup pool uses `3000` and
  `3100`. If there is a conflict, change `compose.yaml`; do not reuse another
  app's port.
- Tunnel credentials are never committed. They live only in
  `/etc/apachas/cloudflared/`.
