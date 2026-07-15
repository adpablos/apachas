# AGENTS.md — A Pachas

A Pachas is a single-page app for splitting party expenses among the Collado
Hermoso crew. There is no build step, no framework, and no dependency install:
the whole frontend lives in `public/index.html` and the whole backend lives in
`server/api.js`.

## Repository Map

- `public/index.html` — the entire frontend: HTML, CSS, and vanilla JS.
- `server/api.js` — the shared-party API: create/read/save, soft delete/restore,
  optimistic revisions, audit, rate limits, and privacy-safe telemetry; in local
  development it also serves `public/`.
- `docs/product.md` — product specification: diagnosis, decisions, P0
  acceptance criteria, and backlog.
- `docs/design.md` — identity and UI rules: logo, exact tokens, typography,
  user-facing voice, and screen structure.
- `REVIEW.md` — the pull-request review contract and required evidence.
- `.claude/skills/` — reusable review, mobile-smoke, and release workflows.
- `compose.yaml` — server stack: nginx, API, and cloudflared.
- `deployment/nginx/default.conf` — nginx static serving plus `/api/` proxy.
- `deployment/nginx/security-headers.conf` — generated CSP plus shared headers.
- `tests/` and `scripts/check.sh` — dependency-free API/browser-core checks.
- `deployment/systemd/` and `scripts/*backup*` — encrypted backup and restore
  verification tooling.
- `CHANGELOG.md` — canonical user-visible and operational release notes.
- `scripts/deploy.sh` — one-command deployment from the Mac.
- `docs/deployment.md` — infrastructure runbook.

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
   `a-pachas-v2`; edit links use `#F:id:key`, read-only links use `#R:id`, and
   write keys stay in the hash so they do not reach logs. Local snapshot links
   use `AP2:`.
   Do not add Spanish payload aliases unless explicitly requested. Shared state
   is v6: bought-item consumers are explicit IDs, people have an `active` flag,
   and completed Bizums are transfer entities that affect balances. Recent live
   party pointers use `a-pachas-recent-v1` and remain local to the phone.
3. Local mode must keep working. If the API is unavailable, the app remains
   usable from localStorage and explains the situation without technical
   jargon. Do not mention sync, revisions, or conflicts in user-facing copy.
4. The deployment server is shared with the World Cup pool production app. Do
   not touch the `current` or `staging` stacks.
5. Cloudflare tunnel credentials never enter the repo. Shared-party data lives
   in the `api-data` volume and must not be logged.
6. Add one concise bullet under `Unreleased` in `CHANGELOG.md` for changes to
   product behavior, persisted data, security, privacy, deployment, or
   recovery. Pure refactors and test-only changes do not need an entry unless
   they affect those contracts. Never rewrite a released section.
7. Treat merge and production release as separate decisions. Do not deploy only
   because a PR merged. By default, leave isolated copy polish, refactors,
   tests, and other small improvements on `main` under `Unreleased`; tell the
   user production is unchanged and offer a release if they need it now.
   Release when the user explicitly asks, an urgent security/privacy/data/
   recovery/availability fix must ship, or accumulated changes form a coherent
   material user outcome. Every distinct SHA deployed normally must use
   `scripts/deploy.sh v0.MINOR.0-beta.N`; never bypass its version, changelog,
   clean-main, health, tag, or GitHub Release guards. Increment `beta.N` for
   compatible refinements; increment `MINOR` and reset to `beta.1` for a
   substantial capability or data-contract evolution. A same-SHA operational
   restart may retain its existing version.
8. Verify before declaring work done. Run `scripts/check.sh`, then run the local
   app with `node server/api.js` and test the full mobile flow: create, join by
   edit and read-only links, list,
   quick expense, bought item with price and consumers, Bizums, a later expense
   after a completed Bizum, inactive participants, recent-party reopening, and
   share messages. After deployment, confirm `https://apachas.alexdepablos.es`
   responds; `scripts/deploy.sh <version>` already checks the product version,
   release SHA, web, and API health.
9. Read `REVIEW.md` before reviewing a pull request. Review the changed behavior,
   not only the diff shape, and return either actionable findings with file and
   line references or the exact verdict `ready to merge`. A review does not
   authorize merging or deploying.
10. When a review, incident, or repeated correction reveals reusable knowledge,
    encode it at the narrowest enforceable layer: test or CI for invariants,
    script for deterministic work, this file for always-on facts, or a project
    skill for a conditional workflow. Do not add a guardrail for a one-off issue
    without a plausible recurrence.

## Testing

Local live-party mode:

```sh
node server/api.js
```

Automated quality gate:

```sh
scripts/check.sh
```

Open `http://localhost:8010`. For frontend-only local mode:

```sh
python3 -m http.server -d public
```

Test on a mobile viewport around 390px wide. "Ver una fiesta de ejemplo" loads
demo data and must never upload it to the server. Automated checks cover the API
and core state behavior; the complete interaction and responsive flow remain
browser-based. Agents that support project skills should use
`verify-apachas-mobile` and report the evidence it requires.
