# CLAUDE.md — A Pachas

A Pachas is a single-page app for splitting party expenses among the Collado
Hermoso crew. There is no build step, no framework, and no dependency install:
the whole frontend lives in `public/index.html` and the whole backend lives in
`server/api.js`.

## Repository Map

- `public/index.html` — the entire frontend: HTML, CSS, and vanilla JS.
- `server/api.js` — the shared-party API: create/read/save with optimistic
  revisions; in local development it also serves `public/`.
- `docs/product.md` — product specification: diagnosis, decisions, P0
  acceptance criteria, and backlog. Read it before changing functionality.
- `docs/design.md` — identity and UI rules: logo, exact tokens, typography,
  user-facing voice, and screen structure. Read it before touching styles or
  product copy.
- `compose.yaml` — server stack: nginx, API, and cloudflared.
- `deployment/nginx/default.conf` — nginx static serving plus `/api/` proxy.
- `scripts/deploy.sh` — one-command deployment from the Mac.
- `docs/deployment.md` — infrastructure runbook. Read it before touching the
  server.

## Language Policy

1. Source code, identifiers, implementation comments, commit messages, and
   technical/repository documentation must be written in English.
2. User-facing product copy stays in Spanish from Spain, with the village tone
   defined in `docs/design.md`.
3. The admin role is called "la llave" in the UI. In code and docs, call it
   "admin" or "key holder" unless quoting visible product copy.
4. Persisted data fields, API payloads, endpoints, filenames, internal CSS
   classes, and local implementation identifiers are English. Spanish is only
   for user-facing product copy.

## Rules

1. Keep the frontend and backend as one self-contained file each. Do not add a
   build system, framework, runtime dependency, or `npm install` unless the user
   explicitly asks for it. The only agreed exception is Google Fonts, with a
   system fallback.
2. Use the current English-only data contract. The localStorage key is
   `a-pachas-v2`; live links use `#F:id:key` and keep the key in the hash so it
   does not reach logs. Local snapshot links use `AP2:`. Do not add legacy
   Spanish payload aliases unless explicitly requested. Shared state is v6:
   bought-item consumers are explicit IDs, people have an `active` flag, and
   completed Bizums are transfer entities that affect balances. Recent live
   party pointers use `a-pachas-recent-v1` and remain local to the phone.
3. Local mode must keep working. If the API is unavailable, the app remains
   usable from localStorage and explains the situation without technical
   jargon. Do not mention sync, revisions, or conflicts in user-facing copy.
4. The deployment server is shared with the World Cup pool production app. Do
   not touch the `current` or `staging` stacks.
5. Cloudflare tunnel credentials never enter the repo. Shared-party data lives
   in the `api-data` volume and must not be logged.
6. Verify before declaring work done. Run the local app with `node
   server/api.js` and test the full mobile flow: create, join by link from
   another client, list, quick expense, bought item with price and consumers,
   Bizums, a later expense after a completed Bizum, inactive participants,
   recent-party reopening, and share messages. After deployment, confirm
   `https://apachas.alexdepablos.es` responds; `scripts/deploy.sh` already
   checks web and API health.

## Testing

Local live-party mode:

```sh
node server/api.js
```

Open `http://localhost:8010`; it serves both `public/` and the API. Data is
stored under `server/data/`, which is ignored by git.

Frontend-only local mode:

```sh
python3 -m http.server -d public
```

Test on a mobile viewport around 390px wide. "Ver una fiesta de ejemplo" loads
demo data and must never upload it to the server. A second client can be
simulated with `curl` against `/api/parties/:id` or by opening the `#F:...`
link in another tab/profile. There is no automated test suite; verification is
browser-based.
