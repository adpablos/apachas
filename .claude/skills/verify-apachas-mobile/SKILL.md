---
name: verify-apachas-mobile
description: Verify the complete A Pachas interaction and responsive flow in a mobile browser with isolated local data and two client contexts. Use after user-visible frontend changes, before declaring mobile work complete, during pre-merge review, or when production-visible behavior needs fresh evidence.
---

# Verify A Pachas on Mobile

Exercise the real interface at approximately 390 px wide. Source inspection and
unit tests do not substitute for this workflow.

## Prepare

1. Read `AGENTS.md`, `REVIEW.md`, and the affected sections of
   `docs/design.md` and `docs/product.md`.
2. Run `scripts/check.sh`.
3. Start `node server/api.js` with an unused port and a temporary `DATA_DIR`.
   Keep the process handle and remove the temporary data when finished.
4. Open the local app with browser control, set the viewport near 390 px, and
   use fresh storage. Use a separate browser context or profile for the second
   client. Do not use production party data.

If browser control is unavailable, stop and report the verification as blocked.
Do not claim a visual pass from HTML or tests alone.

## Exercise the Flow

1. Create a plan, choose the creator identity, and retain the edit, read-only,
   and owner capabilities only in their intended client contexts.
2. Join from a second client with the edit link. Add another person, create and
   claim a pending item, record a bought item with price and explicit consumers,
   and add a quick expense.
3. Inspect balances, complete a suggested Bizum, add a later expense, and verify
   the completed transfer still affects the next settlement.
4. Make a participant inactive and confirm their history remains in balances
   while future expense defaults exclude them.
5. Reopen a remembered live plan, switch away and back without losing the
   active plan on failure, and inspect the relevant share-message previews.
6. Open the read-only link in a separate client. Confirm the same state renders
   and every mutation control is absent while permitted account/reminder sharing
   remains read-only.
7. When the current product contract exposes multiple languages, cover stable
   screens and money/access/error copy in every supported language.

For a narrower change, still run the complete flow unless `REVIEW.md` and the
diff make a smaller regression surface demonstrably sufficient. State the
reason for any omitted scenario.

## Inspect and Record

- Check horizontal overflow, fixed navigation, safe-area spacing, touch targets,
  sheet focus trapping and return, Escape behavior, destructive confirmations,
  and browser console errors.
- Capture screenshots for the changed states and at least the expense, accounts,
  and read-only views. If screenshot capture fails after the UI was exercised,
  preserve DOM snapshots and console evidence and label that fallback.
- Report commit SHA, URL, viewport, client separation, `scripts/check.sh`
  result, each scenario's result, evidence paths, console errors, and skips.
- Stop the local server and remove the temporary data before finishing.
