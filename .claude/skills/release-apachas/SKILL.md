---
name: release-apachas
description: Prepare, review, merge, deploy, verify, and conservatively clean up an authorized A Pachas production release through the guarded versioned path. Use only when the user explicitly requests a release or an urgent security, privacy, data, recovery, or availability fix must ship.
---

# Release A Pachas

Close the release loop with exact version and SHA proof. A merge request alone
does not authorize this skill's production steps.

## Authorization Gate

Confirm that production release is in scope under `AGENTS.md`. If the user asked
only for review, fixes, a PR, or a merge, stop before deployment and report that
production is unchanged. Never infer release permission from a clean review.

## Prepare and Review

1. Read `AGENTS.md`, `REVIEW.md`, `docs/deployment.md`, `CHANGELOG.md`, and
   `scripts/deploy.sh` before acting.
2. Fetch `origin/main` and tags. Preserve unrelated changes and restart from the
   real current branch state if the checkout is stale.
3. Run `scripts/check.sh` and `review-apachas-change`. Run
   `verify-apachas-mobile` for user-visible behavior.
4. Keep any requested simplification and the configured pull-request review
   loop before merge. The reviewed head must receive the exact verdict
   `ready to merge`; new commits invalidate that verdict.
5. Merge only when explicitly authorized and after required checks pass.

## Prepare the Version

1. Select the next `v0.MINOR.0-beta.N` according to `AGENTS.md`: increment the
   beta for compatible refinements; increment the minor and reset to beta 1 for
   a substantial capability or data-contract evolution.
2. Move the applicable `Unreleased` notes into a dated version section and add
   its comparison link. Use a reviewed pull request if this requires a new
   commit; do not push an unreviewed release-preparation change to `main`.
3. Re-fetch and require a clean local `main` exactly matching `origin/main`.

## Deploy and Prove

1. Run `scripts/deploy.sh <version>`. Do not reproduce or bypass its commands,
   and never touch the shared `current` or `staging` stacks.
2. Verify the public web response, `/api/live`, `/api/health`, server `HEAD`,
   remote tag, and GitHub prerelease all identify the same exact SHA and version.
3. For user-visible changes, gather fresh mobile-visible production evidence.
   Verify backup freshness when server access is available.
4. Treat a guard failure before production as a safety success. Fix the guard or
   release state through review; never bypass it to force a deployment.

## Clean Up and Report

- Delete only branches and worktrees proven merged and no longer needed. Preserve
  unrelated or unproven worktrees.
- Report the merged SHA, deployed SHA, version, public health evidence, release
  URL, mobile evidence, backup status, and cleanup performed.
- If any proof is missing, name it and do not call the release complete.
