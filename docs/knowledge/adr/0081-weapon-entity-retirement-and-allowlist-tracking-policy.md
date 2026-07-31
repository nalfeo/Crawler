# ADR 0081: Retire the inert weapon-entity path and require explicit allowlist tracking policy

## Status

Accepted

## Date

2026-07-31

## Estimated Complexity

🍎 x 3 — removes one dormant gameplay path and hardens the cross-layer orphaned-system guard plus CI wiring

## Context

`weaponEntitySystem` and its sole producer `spawnWeapon` shipped in a uniquely
expensive dead state: complete enough to have tests and docs, but never wired into
any real visual or headless runtime pipeline.

Issue #666 was created as tracked debt for that state, but the issue was later
closed without the runtime being wired and without the dead path being removed.
That left the orphaned-systems allowlist carrying a closed tracking reference while
the inert code still existed.

The current architecture already has a shipped, runtime-owned weapon path:
`weaponSystem` drives all live player weapon behavior. Wiring the dormant
multi-weapon entity path now would require new runtime producers, visual/headless
pipeline integration, and real-artifact validation across both runtimes. Leaving the
code allowlisted indefinitely would preserve the same failure mode that ADR 0039 was
meant to catch: code can remain shipped inert while appearing administratively
tracked.

The allowlist also serves two distinct purposes that were previously conflated:

- some entries are true live debt and need an issue that stays open until removal or
  wiring;
- some entries are legitimate architecture/documentation exceptions whose reference
  is provenance, not an active todo.

Without an explicit policy on which kind of reference an allowlist entry carries,
a closed issue can silently void the “come back later” promise.

## Decision

- **DEC-001**: Remove `weaponEntitySystem`, `spawnWeapon`, their live exports, and
  inert-path-only tests/docs instead of wiring the dormant path into production.
- **DEC-002**: Keep the active singleton `weaponSystem` as the only shipped weapon
  runtime path unless a future session intentionally designs and wires a real
  multi-weapon entity architecture.
- **DEC-003**: Extend orphaned-system allowlist entries with an explicit
  `trackedIssuePolicy` classification:
  - `reference-only` for provenance/explanatory references that may legitimately be
    closed;
  - `open-required` for live debt trackers that must remain open while the entry is
    still allowlisted.
- **DEC-004**: When `GITHUB_TOKEN` is available, the orphaned-system guard must
  query GitHub issue state and report any `open-required` allowlist entry whose
  tracking issue is already closed.
- **DEC-005**: CI must pass `GITHUB_TOKEN` into the orphaned-system guard step so
  the closed-issue audit runs in the authoritative workflow rather than only in
  local sessions.

## Consequences

### Positive

- **POS-001**: The repository no longer ships a tested-but-never-called weapon
  runtime path that can mislead future maintainers.
- **POS-002**: The active weapon architecture becomes clearer: `weaponSystem` is the
  only production weapon firing path until a future design intentionally changes it.
- **POS-003**: The orphaned-system allowlist becomes semantically precise: active
  debt and historical/provenance references are no longer mixed together.
- **POS-004**: CI can now detect the exact structural gap from #2442 — a still
  allowlisted exemption whose required tracking issue has already been closed.

### Negative

- **NEG-001**: The dormant multi-weapon entity implementation is discarded rather
  than preserved for speculative future use; any future multi-weapon runtime will
  need a fresh design and implementation.
- **NEG-002**: The orphaned-system guard now depends on GitHub issue-state access in
  CI when `open-required` entries exist, adding one more integration point to the
  guard.
- **NEG-003**: Allowlist authors must supply and maintain one more field
  (`trackedIssuePolicy`) on every exemption.

### Risks

- **RSK-001**: If CI ever stops providing a usable token to the orphaned-system
  guard, `open-required` tracking audits could silently degrade unless the workflow
  change is preserved.
- **RSK-002**: A future author could incorrectly classify a live debt item as
  `reference-only`, avoiding the closed-issue audit even though the entry is still a
  real todo.
- **RSK-003**: Removing the dormant path means future multi-weapon work cannot rely
  on resurrecting old tests verbatim; a new runtime design will need new coverage.

## Alternatives Considered

### Wire the weapon-entity path into production

- **ALT-001**: **Description**: Keep `weaponEntitySystem` and `spawnWeapon`, add real
  runtime producers, and wire the system into both visual and headless pipelines.
- **ALT-002**: **Rejection Reason**: This is materially larger and riskier than the
  current issue requires. The repository already ships a working singleton weapon
  path, and the dormant path had zero runtime callers. Wiring it now would be a new
  feature/architecture effort, not the smallest fix.

### Keep the dormant code but only harden the closed-issue audit

- **ALT-003**: **Description**: Preserve `weaponEntitySystem`/`spawnWeapon`, keep them
  allowlisted, and rely on stronger allowlist-tracking checks to prevent silent
  closure of their tracking issue.
- **ALT-004**: **Rejection Reason**: This would still keep shipped inert gameplay code
  in the tree. The issue explicitly asked for a real disposition — wire or delete —
  rather than indefinite allowlisting.

### Require every allowlist reference to stay open

- **ALT-005**: **Description**: Treat every `trackedIssue` as a live issue and fail if
  any referenced issue/PR/ADR is closed.
- **ALT-006**: **Rejection Reason**: Existing legitimate exceptions use closed PRs,
  ADRs, or intentionally closed issues as provenance for real architectural
  indirection. A universal “must be open” rule would create false positives and force
  bad tracking hygiene.
