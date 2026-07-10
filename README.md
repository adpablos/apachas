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

Brand and UI rules live in [docs/design.md](docs/design.md). Product decisions
live in [docs/product.md](docs/product.md).

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
