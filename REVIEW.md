# REVIEW.md — A Pachas Change Review

Use this contract for pull-request and pre-merge reviews. The goal is to catch
changed behavior that violates A Pachas' product, data, privacy, or release
contracts. Do not expand the review into unrelated cleanup.

## Review Procedure

1. Read `AGENTS.md`, the complete diff, and the relevant sections of
   `docs/product.md`, `docs/design.md`, or `docs/deployment.md`.
2. Trace the changed behavior through the frontend, API, persisted state, and
   deployment surface it can affect. Do not review only the edited lines.
3. Run `scripts/check.sh`. For a UI behavior or layout change, also run the
   `verify-apachas-mobile` workflow and state what evidence was inspected.
4. Check whether a recurring failure or correction should become a test,
   deterministic script, always-on rule, or project skill.
5. Report only actionable findings introduced by the change. Use severity,
   file and line references, impact, and the smallest safe correction.

## Required Gates

### Product and data

- Preserve the English-only v6 persisted contract and supported migrations.
- Keep bought-item consumers explicit, inactive people in historical balances,
  and completed Bizums as transfer entities that affect later calculations.
- Keep local mode usable and shared edits server-acknowledged before claiming
  they are saved.
- Keep edit, read-only, owner, admin, and chosen-identity capabilities distinct.
- Update product/design documentation and `CHANGELOG.md` when their documented
  contracts change.

### Security and privacy

- Keep write and owner capabilities out of request URLs, logs, telemetry, and
  normal read-only sharing.
- Reject telemetry that can contain names, concepts, amounts, party data,
  credentials, URLs, or stable advertising/profile identifiers.
- Preserve bounded inputs, rate limits, CSP generation, backup boundaries, and
  the rule that `current` and `staging` stacks are off-limits.

### Frontend and accessibility

- Preserve the current language policy and literal wording for money, access,
  permissions, destructive actions, offline state, and identity limitations.
- Check the approximately 390 px mobile layout, touch targets, focus return,
  Escape behavior, sheet accessibility, and read-only control removal.
- Refresh the generated CSP after inline-script changes and reject stale hashes.

### Operations and release

- Require `scripts/check.sh` before merge and evidence for any skipped manual
  flow.
- Keep merge and deployment as separate decisions. A clean review does not
  authorize either action.
- Never bypass `scripts/deploy.sh v0.MINOR.0-beta.N` or its clean-main,
  changelog, tag, health, SHA, and GitHub Release guards.
- After an authorized release, require public version and SHA proof; use mobile
  evidence for user-visible changes.

## Verdict

If findings exist, list them and do not include a clean verdict. If no findings
remain, return the exact verdict:

`ready to merge`

Then list checks run, evidence inspected, and anything explicitly skipped. Do
not merge, deploy, or clean branches unless the user separately requested it.
