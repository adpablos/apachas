---
name: review-apachas-change
description: Review an A Pachas diff or pull request against its product, data, privacy, accessibility, and release contracts. Use when asked to review changes, assess merge readiness, perform a pre-merge check, or run the repository's Claude review loop.
---

# Review an A Pachas Change

Produce an evidence-backed review without changing, merging, or deploying the
code unless the user separately asks for a fix or release action.

## Workflow

1. Read `AGENTS.md` and `REVIEW.md` completely. Read the relevant product,
   design, deployment, and changelog sections selected by the diff.
2. Establish the intended comparison. For a branch, prefer the merge base with
   `origin/main`; include staged and unstaged changes when the user asks to
   review the working tree. Preserve unrelated local changes.
3. Inspect the full diff and trace each changed behavior through its consumers.
   Pay particular attention to persisted state, link capabilities, balances,
   read-only behavior, privacy-safe telemetry, CSP, and release boundaries.
4. Run `scripts/check.sh`. Treat a failing generated CSP check as a finding; do
   not refresh it during a read-only review.
5. For user-visible behavior, invoke `verify-apachas-mobile` when browser
   control is available. If it is unavailable, name the missing evidence rather
   than inferring success from source inspection.
6. Decide whether a finding exposes a repeatable class of failure. Recommend the
   narrowest durable guardrail only when recurrence is plausible.

## Output

- Lead with findings ordered by severity.
- Give each finding a file and line reference, concrete impact, and smallest
  safe correction.
- Do not report unrelated pre-existing issues or speculative preferences.
- If findings remain, do not include a clean verdict.
- If no findings remain, return the exact line `ready to merge`, followed by
  checks run, evidence inspected, and explicit skips.
- Never treat review approval as permission to merge or deploy.
