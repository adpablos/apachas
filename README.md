# A Pachas

Party expenses for the Collado Hermoso crew, split evenly and settled with
minimum Bizums.

**Production:** https://apachas.alexdepablos.es

The group writes the party shopping list, each person claims what they will
bring, bought items record price, payer, and consumers, and A Pachas calculates
the minimum transfers required to settle up. The party is shared by WhatsApp
link, with no accounts and no sign-in. If the network is unavailable, the app
keeps the last confirmed party available for consultation, but shared changes
wait for a live server response instead of pretending to be saved locally.

The product is intentionally small:

- `public/index.html` contains the whole frontend.
- `server/api.js` contains the whole API, using only the Node standard library.
- There is no build step and no dependency install.

Live parties keep a bounded, server-derived activity trail. Operational logs
are structured and privacy-minimized: request/release correlation uses one-way
party and device references, never names, party contents, write keys, IPs, or
full URLs. Browser telemetry is limited to a fixed technical/usage taxonomy. See the
operations and privacy contract in [docs/deployment.md](docs/deployment.md) and
[docs/product.md](docs/product.md).

The private beta has two explicit capabilities: `#F:` links can edit and
`#R:` links can only read. Global deletion requires a separate creator-phone
capability and remains reversible for seven days. That capability never appears
in shared links or party state.

Run the dependency-free quality gate before opening a pull request:

```sh
scripts/check.sh
```

If the inline frontend changes, refresh its generated CSP first with
`node scripts/update_csp.js`.

Brand and UI rules live in [docs/design.md](docs/design.md). Product decisions
live in [docs/product.md](docs/product.md).

## Releases

The family-and-friends beta starts at `v0.1.0-beta.1`. Annotated Git tags are
the human product version, while `APP_RELEASE` remains the exact deployed Git
SHA and `STATE_VERSION` remains only the persisted-data contract version.

Every product, data, security, privacy, deployment, or recovery change is added
under `Unreleased` in [CHANGELOG.md](CHANGELOG.md). The short release procedure
is documented in [docs/deployment.md](docs/deployment.md#versioning-and-release-recording).

## Language Policy

Source code, identifiers, implementation comments, commit messages, and
technical/repository documentation are written in English.

User-facing product copy stays in Spanish from Spain, with the village tone
defined in `docs/design.md`. Persisted data fields, API payloads, endpoints,
filenames, internal CSS classes, and local implementation identifiers are
English.

## Development

Run the local API and frontend together:

```sh
node server/api.js
```

Open `http://localhost:8010`.

For frontend-only local mode:

```sh
python3 -m http.server -d public
```

## Deployment

```sh
scripts/deploy.sh
```

The full infrastructure runbook is in [docs/deployment.md](docs/deployment.md).
