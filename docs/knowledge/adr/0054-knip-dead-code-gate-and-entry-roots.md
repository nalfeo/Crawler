# ADR 0054: Knip dead-code gate and entry roots

## Status

Accepted

## Date

2026-07-09

## Estimated Complexity

🍎 x 3 — tightens an existing tooling gate and trims dead surfaces across multiple layers without new runtime systems

## Context

- **CTX-001**: `npm run lint:dead-code` only ran `knip --dependencies`, so it could report a clean result while unused files and exports still accumulated in `src/**` and `scripts/sprites/**`.
- **CTX-002**: Crawler loads labs dynamically via `import.meta.glob(...)` and keeps a handful of public barrel files (`src/core/index.ts`, `src/game/index.ts`, `src/engine/index.ts`, etc.) as intentional entry roots. A naive Knip files/exports pass reports those as dead even when they are live by design.
- **CTX-003**: The repo already treats Knip as an advisory dead-code signal in CI and opt-in local verify (`VERIFY_KNIP=1`). Tightening that signal needed to preserve the existing advisory posture while making the result honest enough to act on.
- **CTX-004**: This cleanup touched multiple architectural layers (`src/core`, `src/engine`, `src/game`, `src/shared`, `src/labs`) because stale exports had accumulated in helper modules and constants, not because any gameplay or rendering behavior needed to change.

## Decision

- **DEC-001**: Expand `npm run lint:dead-code` to run Knip against unused **dependencies, exports, and files**, not dependencies alone.
- **DEC-002**: Teach `knip.json` about Crawler's real entry roots by adding dynamic lab entries, key public barrel modules, and the sidecar CLI entrypoint so Knip does not misclassify them as dead files/exports.
- **DEC-003**: Include `tests/**/*.ts` in Knip's project scope so test imports count as legitimate usage when evaluating dead exports.
- **DEC-004**: Keep the gate advisory inside `scripts/agent/verify.sh` by routing `VERIFY_KNIP=1` through `npm run lint:dead-code`, aligning the local opt-in verify path with the dedicated lint command instead of introducing a second Knip rule set.
- **DEC-005**: Remove or de-export the unused file/helpers/constants the tightened Knip pass surfaced, preferring behavior-preserving export trimming over broader refactors.

## Consequences

### Positive

- **POS-001**: `npm run lint:dead-code` now measures the dead-code classes the team actually cares about: unused files and exports as well as dependencies.
- **POS-002**: Dynamic labs and intentional public roots stay represented honestly, so the dead-code report is actionable instead of noisy.
- **POS-003**: Local opt-in verify and the dedicated dead-code lint now execute the same Knip rule set, reducing drift between "what I checked locally" and "what the branch says is clean."
- **POS-004**: Removing stale exports shrinks accidental public surface area across gameplay, engine, shared, and sprite-workflow modules without changing runtime behavior.

### Negative

- **NEG-001**: Knip configuration is now more explicit and repo-specific; new dynamic entry roots or public barrels must be added deliberately or they will show up as dead-code findings.
- **NEG-002**: The cleanup diff is mechanically broad because dead exports had accumulated across many layers, which increases review surface even though the changes are behavior-preserving.

### Risks

- **RSK-001**: A future session may cargo-cult new files into `entry` just to silence Knip instead of deciding whether they are real public roots or actual dead code.
- **RSK-002**: Because the gate remains advisory in default `verify`, stale exports can still accumulate if authors skip `npm run lint:dead-code` or `VERIFY_KNIP=1 npm run verify` during refactors.

## Alternatives Considered

### Keep dependency-only Knip

- **ALT-001**: **Description**: Leave `lint:dead-code` as `knip --dependencies` and treat unused files/exports as a manual cleanup concern.
- **ALT-002**: **Rejection Reason**: This preserved a false-clean signal: the command already returned success while dead files/exports were present, which defeated the user's requested cleanup metric.

### Run broad Knip without entry-root tuning

- **ALT-003**: **Description**: Turn on files/exports reporting but keep the old `knip.json` scope and let reviewers sort real issues from false positives by hand.
- **ALT-004**: **Rejection Reason**: The first prototype produced heavy noise from `import.meta.glob` lab loading and intentional barrel files, making the report too misleading to use as a gate.

### Write a custom dead-code checker

- **ALT-005**: **Description**: Build a bespoke repo-specific script for dynamic labs, sprite scripts, and public barrels instead of using Knip's built-in files/exports analysis.
- **ALT-006**: **Rejection Reason**: Knip already had the needed primitives (`entry`, `project`, built-in export/file analysis, and auto-fix). A custom checker would add maintenance burden without a clear accuracy win.
