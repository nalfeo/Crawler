# ADR 0072: Repository Prettier Gate Repair

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

3 apples - mechanical formatting spans multiple architectural paths but changes no runtime behavior

## Context

The mandatory pre-push hook runs Prettier across all TypeScript source, test, and script
files rather than only the current branch diff. Current `main` contained 28 files that did
not match the checked-in Prettier configuration. As a result, every branch push was blocked
even when its own changed files were formatted and its focused verification passed.

The violations crossed bootstrap, engine, game, labs, shared data, tests, and agent tooling.
The PR prerequisite guard therefore classified the repair as cross-system and required an
ADR, even though the formatter changes are mechanical.

## Decision

Apply the repository's existing `npm run format` command to all reported violations and
commit the resulting changes separately from the resumable asset-pipeline feature.

- **DEC-001**: Treat the checked-in Prettier configuration as authoritative; do not hand-edit
  formatter output.
- **DEC-002**: Keep the repair in a dedicated commit so reviewers can isolate it from
  behavior changes.
- **DEC-003**: Require `npm run format:check` and `npm run verify:fast` to pass after the
  repair.
- **DEC-004**: Do not interpret formatting-only changes as permission to alter gameplay,
  public contracts, or architectural ownership.

## Consequences

### Positive

- **POS-001**: Restores the mandatory pre-push formatting gate for this and subsequent
  branches.
- **POS-002**: Removes repository-wide format drift using one deterministic command.
- **POS-003**: Keeps the functional asset-pipeline implementation reviewable in its own
  commit.

### Negative

- **NEG-001**: Expands this pull request with formatting-only changes outside the feature's
  primary files.
- **NEG-002**: Path-based scope detection schedules broader validation despite no intended
  runtime behavior change.

### Risks

- **RSK-001**: Formatting changes may conflict with concurrent branches editing the same
  files; the separate commit makes those conflicts easy to identify and resolve.
- **RSK-002**: Reviewers may mistake compacted formatter output for behavior changes; the
  commit boundary and this ADR document the mechanical origin.

## Alternatives Considered

### Bypass the pre-push hook

- **ALT-001**: **Description**: Push with `--no-verify` after validating only the feature
  files.
- **ALT-002**: **Rejection Reason**: This would leave the repository-wide gate red and
  violate the policy that encountered gate failures are fixed rather than skipped.

### Revert the formatting repair

- **ALT-003**: **Description**: Keep the feature branch narrow and leave the 28 violations
  on `main`.
- **ALT-004**: **Rejection Reason**: Every subsequent normal push would remain blocked by
  the same deterministic failure.

### Publish a separate formatting pull request first

- **ALT-005**: **Description**: Move the mechanical repair to another branch and wait for it
  to merge before publishing the asset-pipeline branch.
- **ALT-006**: **Rejection Reason**: It would serialize two otherwise independent changes,
  while the dedicated commit already preserves review isolation without delaying the
  requested feature.
