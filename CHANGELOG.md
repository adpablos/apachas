# Changelog

This file records notable user-visible, data-contract, security, and operational
changes to A Pachas. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

During the family-and-friends beta, releases use `0.MINOR.0-beta.N`. Small fixes
and improvements increment `N`; a substantial new capability increments
`MINOR` and resets the suffix to `beta.1`. Version `1.0.0` is reserved for a
stable, publicly supported product contract.

## [Unreleased]

<!-- Add concise bullets here for product, data, security, privacy, deployment,
or recovery changes. Pure refactors and test-only changes need no entry. -->

## [0.1.0-beta.1] - 2026-07-12

First family-and-friends beta.

### Added

- Live shared parties with separate edit and read-only WhatsApp links.
- A mobile-first shopping list, quick expenses, explicit consumers, balances,
  and completed Bizum transfers that remain part of later calculations.
- Recent-party recovery, inactive participants, activity history, onboarding,
  privacy guidance, and creator-only deletion with a seven-day restore window.
- Privacy-safe operational telemetry, request correlation, health endpoints,
  rate limits, strict Content Security Policy checks, and production uptime CI.
- Encrypted age backups, retention, hardened daily scheduling, and a
  non-destructive restore validator.

### Changed

- Shared state now uses the English-only v6 contract while preserving supported
  existing parties through read-time migration.
- Shared edits require a live server acknowledgement instead of implying that
  offline changes will synchronize later.

[Unreleased]: https://github.com/adpablos/apachas/compare/v0.1.0-beta.1...HEAD
[0.1.0-beta.1]: https://github.com/adpablos/apachas/releases/tag/v0.1.0-beta.1
