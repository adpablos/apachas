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
provisioned sensitive material is the tunnel credential, which lives outside
the repo. A randomly generated observability key lives inside the data volume and only produces
one-way party/device references for correlation; it is never returned or logged.

## Server Paths

These are the canonical deployment paths for A Pachas. Changing them is a server migration, not a cosmetic repo change.

| What                       | Where                              |
| -------------------------- | ---------------------------------- |
| Deployment clone           | `/opt/apachas`                     |
| Tunnel config/credentials  | `/etc/apachas/cloudflared/`        |
| Backup public recipients   | `/etc/apachas/backup-recipients.txt` |
| Encrypted backup artifacts | `/var/backups/apachas/`            |
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
deployed SHA.

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

## Encrypted Backups

`scripts/backup_data.sh` creates a stable snapshot of active parties, the
seven-day soft-delete area, and `.observability-key`; validates every captured
JSON document; encrypts the archive with public `age` recipients; emits a
content-free size/hash/count manifest; and keeps 30 days. The server must never
hold the private age identity.

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
