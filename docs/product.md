# Product — What A Pachas Improves and Why

Product specification started on 2026-07-05 and updated for the v6 trust and
simplicity pass. It starts from market research done
with Codex (Tricount, Splitwise, Settle Up, Splid, Spliit, Tab, Google Pay
split), compares it with the real code in `public/index.html`, and records
decisions rather than open options. The appendix captures where the original
analysis was wrong or incomplete.

## Thesis

A Pachas does not compete with Tricount on completeness. It competes on a
narrower and more valuable promise for a village party group:

> Send it to the group, everyone records their part, and the final Bizums fall
> out automatically.

Today the app delivers that promise with live shared parties, explicit
consumer splits, real transfer history, minimum pending Bizums, and a low-
friction entry with no accounts or install. WhatsApp remains the door and
loudspeaker; A Pachas is the shared source of truth.

## Original Diagnosis, Resolved in v2

The list below records the problems that justified the v2 rebuild. It is
historical context, not the current product state.

1. **Collaboration by copy, not live state.** Two people edit different copies
   while believing "the app" is current. This forces a scribe mode: one person
   records everything and reshares the link. It contradicts the product promise.
2. **The link acts as invitation, backup, and data transport at once.** Chat
   links are huge, stale snapshots overwrite local parties when opened, and the
   full party state travels in every message.
3. **No direct expense.** In a real party, many expenses appear after payment,
   such as "I bought ice, EUR 6". Today that takes two steps: add to list, then
   mark as bought. Also, people without the key cannot say someone else paid.
4. **Accounts do not answer "what about me?" first.** The Accounts screen shows
   total, a "per head" figure, and everyone's Bizums. Your own balance is in
   another tab, without breakdown. "Per head" is misleading when not every
   purchase is consumed by everyone.
5. **WhatsApp is generic share.** There are invite and accounts texts, but no
   moment-specific messages: missing items, individual reminder with debt,
   closing message. The text sent to the group is part of the product.
6. **The Fiesta screen does not say what is next.** It repeats identity and
   hero content, but the main action is hidden in another tab.
7. **Minimal audit trail is missing.** An expense does not say who created it or
   when it was touched. Deleting a purchase is implicit behind edit flow, not an
   explicit confirmation. Money workflows need inspectability to build trust.

## Market Lessons

- **Tricount**: wins because everyone sees the same thing and everyone can add,
  not because of multicurrency. That was A Pachas' original gap; live parties
  now cover it without adding accounts.
- **Splitwise**: shows where not to grow first: categories, recurring expenses,
  IOUs. Copy balance clarity, not density.
- **Settle Up**: "who pays now" fits party shopping lists: spread the burden
  during the party instead of adjusting after. Clear P1.
- **Splid**: the mental model reference: no account, local if offline, shared
  when online. This is the architecture north star.
- **Spliit**: even the minimal open-source option has shared groups. "No
  backend" is no longer the differentiator; "no accounts" still is.
- **Tab**: receipt OCR only matters when the problem is long repeated bar
  receipts. Not the current case.
- **Google Pay split**: in Spain, payment friction is Bizum and there is no
  official API. The value is telling someone "your only Bizum is X to Y" and
  giving them copyable text. Do not chase unofficial integrations.

WhatsApp is the door and loudspeaker, not the editing surface. Business Platform
and Flows require a business account, approved templates, webhooks, and a more
serious server. That is phase 3 at earliest. The MVP is short live links plus
excellent prefilled messages through `navigator.share` and `wa.me`.

## Decisions

### D1. Live Party by Link, With a Minimal Owned Backend

Snapshots end: a shared party lives on the server and the short link references
it. No accounts, no users, no database: one JSON document per party.

- **Single-file API**: `server/api.js`, Node >=18, no dependencies, matching the
  one-file frontend. Endpoints: `POST /api/parties` to create,
  `GET /api/parties/:id` to read with `?rev=` for cheap polling, and
  `PUT /api/parties/:id` to save with optimistic revision control. Each party
  document also carries a server-owned, bounded audit trail that clients can
  read but cannot submit or rewrite.
- **Two link capabilities**: `#F:<id>:<key>` can edit and `#R:<id>` can only
  read. The write key lives in the hash, so nginx and Cloudflare never see it
  in logs. The read link contains no write capability. Anyone with the edit
  link can still choose an existing identity; "la llave" coordinates the group
  but is not authentication.
- **Creator recovery capability**: creation also returns an independent
  `ownerKey`. It stays only on the creator's phone, never enters shared state,
  normal links, audit events, telemetry, or logs, and is required for global
  deletion and restoration.
- **Live edits require the API**: localStorage keeps only the opened party,
  identity, tab, and recovery backup. A shared party change is shown as saved
  only after the server accepts it. If the network or server is down, the user
  gets a clear "necesitas internet" error instead of a local change that might
  sync later.
- **AP2 is backup, not invitation**: local snapshot links can still be decoded
  for recovery/import, but normal group sharing is live-only. If a local party
  cannot be made live, or if the app is still reconciling state, WhatsApp/copy
  sharing is blocked instead of sending a frozen or stale state that looks like
  an invitation.
- **No technical sync language**: save shared changes directly through the API;
  download on open, when the app becomes visible, and about every 12 seconds.
  User-facing status is "al día hace un momento". If offline, say internet is
  needed to change the party.
- **Conflicts**: entity-level merge; latest edit wins by `updatedAt`, and tombstones
  prevent deleted entities from coming back. For a 5-15 person group where most
  edits are additions, this is enough. Do not ask users to understand versions.

Tradeoff: the product is no longer 100% static. In exchange, it remains "two
product files" (one HTML, one server JS) with the same Compose deployment. This
is the highest-return change in the spec.

### D2. One Item Model, Not Two Collections

The original analysis proposed separate `shoppingItems` and `expenses`. Do not
do that. The current item model, `item.status: pending | claimed | bought`,
already captures planning -> expense with a single object. That is A Pachas'
own advantage: the list and accounts are the same thing seen at two moments. A
direct expense is simply an item born `bought`. Splitting collections would
duplicate UI and merge logic without enough benefit at this scale.

### D3. Quick Expense as a Primary Action

Use one expense sheet for direct expense, marking a list item as bought, and
editing a purchase: concept, price, payer, and consumers. Default payer is the
current user, but anyone can change it. Consumers default to everyone. Saving a
shared expense should take four actions: button, concept, price, save.

### D4. Accounts Answer "What About Me?" First

The top of Accounts shows the current user's status: "Estás en paz", "Debes
12,40 EUR", or "Te deben 8,10 EUR", with the explanatory breakdown and concrete
action. "Per head" appears only when every purchase is consumed by everyone; if
there are partial consumptions, replace it with "repartido según quién cata cada
cosa". Total, everyone's Bizums, and share remain below.

### D5. Moment-Specific WhatsApp Kit

Four messages, written so the group can act without asking, with preview before
send, WhatsApp button, native share, and copy:

1. **Invite**: enter, say who you are, record what you buy.
2. **Missing items**: list unowned items and link.
3. **Accounts**: total, Bizums with check/dot state, neutral consultation copy,
   and a read-only link. If settled, closing message.
4. **Individual reminder**: what the person should bring and/or their Bizum.

### D6. Fiesta Becomes Actionable Home

Inside a party, the large hero is redundant. The screen becomes: party card with
sync status and "Mandar al grupo"; "¿Qué toca?" card with exactly one action
based on state; the current user's balance; identity; and existing links. The
full hero remains only for the entry state without a party.

### D7. Minimal Server-Derived History, Not Accounting

Each item stores who created it and when, plus who last touched it. The edit
sheet shows that in one line. The API derives a bounded activity trail from
accepted before/after states; clients cannot submit or rewrite it. The actor is
the identity selected on that phone, not verified identity, and the UI says so.
Deleting a priced purchase asks for explicit confirmation.

### D8. Completed Bizums Are Transfers, Not Checkboxes

Marking a suggested Bizum creates a transfer entity that changes both people's
balances. Later expenses are calculated on top of those real money movements,
so nobody is asked to pay the same debt twice. Completed transfers remain
visible and can be undone with confirmation when marked by mistake. If two
phones confirm the same recommendation from the same accounting state, both
derive the same transfer ID so concurrent merging retains one payment. Undo
tombstones are part of that basis, so confirming the recommendation again after
a correction creates a new transfer rather than colliding with the old record.

### D9. Membership Changes Never Rewrite History

Bought items store the exact consumer IDs present when the expense is saved;
"everyone" is a UI shortcut, not a dynamic relationship. People can become
inactive for future expenses while their purchases, shares, transfers, and
balances remain intact. Permanent deletion is available only with no history.

### D10. Progressive Expense Details

Payer and consumers use compact summaries by default. "Cambiar" reveals the
full pills, with Todos and Solo yo shortcuts. A discreet suggestion identifies
the active person with the lowest balance as the best next payer, without
changing the real payer automatically.

### D11. Continuity Without Accounts

Each phone remembers up to five live party links and can reopen them from the
entry screen without weakening a write capability already stored on that
phone. Opening an explicit `#R:` link remains read-only for that session. Key
holders can start a new party from the current pending list; prices,
assignments, transfers, and balances never carry over.

### D12. Family-and-Friends Beta Boundaries

- The entry screen states the private-beta status, the product promise, and the
  three-step create/share/settle flow before asking for anything.
- Every screen links to concise privacy and help copy with a direct support
  address. It explains stored data, link capabilities, unverified identity,
  retention, infrastructure, and privacy-minimized operational signals.
- Global deletion belongs only to the creator-phone capability, not to a
  self-declared admin. It is a seven-day soft delete; only that phone can
  restore it. Legacy parties without an owner capability remain usable but
  cannot be globally deleted through the app.
- The beta collects only allowlisted technical errors and five coarse product
  signals: write/read opens, edit/read share intent, and support intent. There
  are no third-party analytics, advertising identifiers, names, amounts,
  concepts, request bodies, or full URLs in telemetry.
- Availability is covered by external uptime checks, structured privacy-safe
  logs, bounded rate limits, encrypted daily backups, a tested restore checker,
  CSP generation, and dependency-free CI.

## P0 Specification

Everything in this section is implemented by this branch.

### Data Model, v6

```js
// Shared: sent to the server and encoded only in AP2 recovery snapshots.
{
  v: 6,
  party: { name, date, updatedAt },
  people: [{ id, name, admin, active, updatedAt }],
  items:  [{
    id, name,
    status: 'pending' | 'claimed' | 'bought',
    claimerId?,                             // only for claimed
    priceCents?, payerId?, consumers?,      // bought items use explicit consumer IDs
    createdAt?, createdBy?, updatedAt, updatedBy?,
  }],
  transfers: [{ id, fromId, toId, cents, createdAt, createdBy?, updatedAt, updatedBy? }],
  tombstones: [{ id, at, seenAt }],
}
// Server-owned, returned beside state and never accepted from clients:
audit: [{ id, rev, at, action, entityId?, actorId?, deviceRef?, label?, changes }]

// Local only, never uploaded as shared state:
// me, tab, remote: { id, key?, ownerKey?, rev }, pendingUpload,
// localReadOnly, localSavedAt
```

The localStorage key remains `a-pachas-v2`. `AP2:` links are generated as
local-mode backups. Stored v5 parties migrate to v6 on read: null consumer lists
freeze to the people present at migration and completed settlement marks become
transfers. The API rejects new v5 writes so a stale browser cannot erase v6
history. The app does not accept Spanish payload aliases. Current and recent
phone data expire locally after 90 days without use; the one-step recovery copy
expires after seven days. Users can forget one party or clear all A Pachas data
and write capabilities stored on that phone.

### API

- `POST /api/parties` body `{state, actorId?, deviceId?}` ->
  `201 {id, key, ownerKey, rev:1, audit}`.
- `GET /api/parties/:id[?rev=n]` -> `200 {rev, state, updatedAt, audit}` or `204`.
  Use 204, not 304, because `fetch` handles it more cleanly here.
- `PUT /api/parties/:id` body `{key, rev, state, actorId?, deviceId?}` ->
  `200 {rev, audit}`,
  `409 {rev, state}`, `403`, `404`, `413`, or `400`.
- `DELETE /api/parties/:id` requires `ownerKey`, the current revision, and exact
  party-name confirmation. It atomically moves the complete document to a
  seven-day trash area and returns `202 {purgeAt}`.
- `POST /api/parties/:id/restore` requires the same `ownerKey` and restores the
  document before `purgeAt`.
- `POST /api/events` accepts only fixed, content-free technical and usage codes.
- `GET /api/live` checks the process. `GET /api/health` checks storage readiness
  and returns the deployed release SHA.
- Guardrails: JSON <= 256 KB, strict shape validation, crypto IDs, atomic
  tmp+rename writes, best-effort rate limit by IP, global party cap on disk, and
  no party content or IDs in logs. The party ID alone grants read access.
  Untouched parties are purged after eight months. General, creation, and
  client-event rate limits return `Retry-After` with `429`.
- Deployment: `api` container with `node:22-alpine`, no npm install, in the
  existing Compose project. nginx proxies `/api/` and continues serving static
  files. Locally, `node server/api.js` serves both API and `public/`.

### Acceptance Criteria

1. **Live party**: Edu records "Hielo 6 EUR" on his phone; Marta opens the same
   group link from three days ago and sees it without anyone resending. Five
   people edit the same party from different phones without overwriting each
   other.
2. **Quick expense**: with identity selected, recording a shared expense takes
   four actions. Errors use product voice: "Pon qué fue", "Ponle precio, que
   gratis no fue".
3. **List**: stays simple: add, claim, assign with key, mark bought. Pending and
   bought items are visually separated.
4. **Accounts**: first thing visible is the user's own status and action. "Per
   head" appears only when true.
5. **WhatsApp**: all four messages have preview, native share, WhatsApp button,
   and copy fallback once the party has a live `#F:` link and the current phone
   has uploaded its latest changes. Local-only parties must be made live first;
   if the API is unavailable, the app must not send an `AP2:` snapshot or stale
   live link as a normal group invitation.
6. **Offline / no server**: viewing and local identity remain usable, but shared
   changes and group sharing require internet. Failed edits are not shown as
   saved locally.
7. **Local to live**: an imported local party can go live in one tap; the demo
   never uploads.
8. **Transfers**: after a suggested Bizum is marked complete, later expenses
   calculate from the remaining balance rather than charging that transfer
   again. Undoing the transfer recalculates the recommendations.
9. **Membership**: adding or deactivating a person never changes consumers or
   balances for earlier expenses. Inactive people remain available for account
   settlement and can be reactivated.
10. **Safe interaction**: money and membership writes disable their initiating
    control while saving; destructive actions confirm; sheets support close,
    Escape, focus trapping, focus return, and hidden closed state.
11. **Continuity**: the entry screen can reopen up to five recent live parties,
    and repeating a pending list creates a clean party with no old money state.
12. **Capabilities**: `#F:` can edit; `#R:` adopts server truth and exposes no
    shared mutation controls. Accounts sharing always uses `#R:`. Explicitly
    opening `#R:` never silently upgrades the current session to edit access.
13. **Deletion and recovery**: only the creator phone can soft-delete globally,
    exact name and current revision are required, reads return `410`, and the
    creator can restore for seven days. "La llave" alone cannot delete.
14. **Beta trust**: entry onboarding, privacy/help copy, edit-link warning, and
    read-only labels accurately describe the no-account trust model.
15. **Operational readiness**: CI covers API and core browser behavior; CSP is
    generated from the actual inline blocks; uptime checks web, CSP, liveness,
    and readiness; encrypted backups pass a non-destructive restore check.

## P1, Next Batch

1. **Receipt photo without OCR**: client-compressed thumbnail on the expense.
   Raises trust and reduces arguments. Requires choosing backend upload shape.
2. **Exact per-consumer amounts**: useful for bar tabs; hidden behind "more
   options", never in the default flow.
3. **Beta feedback prompt**: a lightweight, dismissible invitation to send
   feedback after a party is settled; no in-product survey SDK.
4. **Recent-party management**: name a favorite or archive a fully settled
   party. Manual phone forgetting and complete local-data clearing already
   exist.

## P2 Bets

- OCR or AI scan of receipts; parser for pasted chat text.
- WhatsApp bot or Flows. Requires Business Platform, templates, webhooks, and a
  dedicated number. Not before there is real habit and backend confidence.
- Nice export: vertical image for the group, backup CSV.

## Non-Goals

- User accounts, email, or phone numbers. Never in P0-P1.
- Categories, multicurrency, recurring expenses, comments. Splitwise density is
  not worth it at this scale.
- Unofficial Bizum deep links. Too fragile; copyable text with amount and
  recipient is enough.
- Frontend framework or build step; npm install on the backend.

## Risks and Mitigations

- **Backend breaks the "no infra" magic**: one file, one JSON per party, zero
  dependencies; confirmed data stays readable without the API; `AP2:` links
  remain manual backup.
- **Anyone with the edit link can edit**: acceptable for known groups and
  explicit in the UI. Identity and "la llave" coordinate the group but are not
  authentication. Accounts use a separate read-only link, destructive actions
  confirm, and global deletion requires a creator capability that edit links do
  not carry. IDs and keys are cryptographically random; write keys stay in the
  fragment.
- **Edit conflicts**: entity merge with last-write-wins and tombstones. The
  realistic worst case, two people editing the same price, resolves by arrival
  order and can be corrected in one tap.
- **Server is shared with the World Cup pool**: the `apachas` stack remains
  isolated; the API only adds one container to that project. Guardrails in
  `docs/deployment.md` remain active.

## Observability and Audit Without Invasive Analytics

- API logs are structured JSON. Successful writes, slow requests, failures,
  sanitized exceptions, cleanup, startup, client errors, and five-minute metric
  snapshots are recorded. Successful polls and healthchecks are aggregated
  rather than written as one log line each.
- Logs contain route templates, status, latency, release, request IDs, and
  HMAC-based party/device references. They never contain party IDs, write keys,
  names, item content, amounts, IPs, user agents, request bodies, full URLs, or
  URL fragments.
- nginx uses a separate URI-free JSON access log for upstream status and latency
  so 502/504 failures remain visible without exposing read-capability IDs.
- The browser reports only fixed error/usage codes, safe route names, status
  codes, request IDs, and pseudonymous party/device references. It never sends
  DOM, localStorage, URLs, state, names, concepts, amounts, or HTTP bodies.
- The server derives audit events from the accepted before/after states. The
  actor remains a declared identity, not authenticated identity; the UI states
  that boundary explicitly. Events are capped at 200 and 256 KB, and expire or
  delete with the party.

## Appendix: Corrections to the Original Analysis

1. The proposed join flow already exists: "¿Quién eres?" sheet with person
   pills, "apúntate", and the ability to inspect without choosing. Keep it.
2. Splitting `shoppingItems` and `expenses` is rejected by D2. The current
   `pending|claimed|bought` state already unifies planning and expense.
3. Direct expense is not just hidden; it currently takes two steps and only the
   key holder can change payer. Both problems must be fixed.
4. "Per head" is truly misleading today: it divides total by the whole group
   even when purchases have partial consumers. The demo itself shows this.
5. `paidBy: [...]` multi-payer is out of P0. It complicates merge and UI for a
   rare village-party case; record two expenses instead.
6. Keep the Peña tab. It owns per-person balances, key-holder management, and
   person sheets. Accounts simply stops forcing users through it to know their
   own status.
7. The original analysis was right about: live party as the top change,
   WhatsApp as loudspeaker rather than editor, moment-specific messages,
   "your account" first, and no OCR/bot/Flows in the MVP.
