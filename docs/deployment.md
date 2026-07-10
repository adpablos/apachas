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

There is no build step and no application secret. Party data lives in the
`api-data` volume. It is lost only with `docker compose down -v`; untouched
parties are automatically purged after eight months. The only sensitive
material is the tunnel credential, which lives outside the repo.

## Server Paths

These are the canonical deployment paths for A Pachas. Changing them is a server migration, not a cosmetic repo change.

| What                       | Where                              |
| -------------------------- | ---------------------------------- |
| Deployment clone           | `/opt/apachas`                     |
| Tunnel config/credentials  | `/etc/apachas/cloudflared/`        |
| Local smoke port           | `127.0.0.1:3200`                   |
| Compose project            | `apachas`                          |

## Normal Deployment

Commit and push to `main`, then run from the Mac:

```bash
scripts/deploy.sh
```

The script runs `git pull --ff-only` and `docker compose up -d --wait` on the
server, then verifies that `https://apachas.alexdepablos.es` responds. Because
`public/` is mounted directly into nginx, content-only changes do not require a
container restart. Changes to `server/api.js` or nginx config do need a restart;
`up` does not detect changes in mounted files, so use:

```bash
sudo docker compose restart api    # or web, if deployment/nginx/ changed
```

Equivalent manual flow on the server:

```bash
cd /opt/apachas
git pull --ff-only
sudo docker compose up -d --wait
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
   sudo docker compose up -d --wait
   curl -fsS https://apachas.alexdepablos.es >/dev/null && echo OK
   ```

## Operations

Status and logs:

```bash
sudo docker compose -p apachas ps
sudo docker compose -p apachas logs -f cloudflared
sudo docker compose -p apachas logs -f web
```

Rollback. Content is the repo, so rollback is git:

```bash
cd /opt/apachas
git log --oneline -5          # pick the known-good commit
git reset --hard <commit>     # or revert + push from the Mac, preferred
sudo docker compose up -d --wait
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
