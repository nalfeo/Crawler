# ADR 0014: PR150 post-merge review follow-up scope

## Status

Accepted

## Date

2026-06-19

## Estimated Complexity

🍎 x 3 — touches labs, engine, game, and shared layers without introducing new runtime systems.

## Context

PR #150 merged after CI passed and conversation resolution was enforced. A later audit found several resolved review comments that were still relevant to current `main`, spanning multiple layers:

- a lab discoverability defect (`bt-viz` not registered),
- stale or misleading docs/comments in engine/shared/game code,
- an orphaned config file no longer used by the manifest-based Floor 1 pipeline.

The fix set crosses 2+ architectural areas, which requires an ADR under repository policy.

## Decision

Ship a focused post-merge follow-up PR that only includes low-risk, high-confidence fixes from the audited comments:

- register `bt-viz` through `registerLab('bt-viz', ...)`,
- remove the unused legacy Floor 1 config file, now superseded by
  `src/shared/data/floors/floor1.manifest.json`,
- align test/docs/comments/names with current behavior and units,
- hoist one gameplay magic number to a named constant.

Explicitly defer higher-risk behavior changes (for example behavior-tree scheduling semantics and pulse-shield knockback model) to dedicated design/implementation PRs.

## Consequences

### Positive

- Restores bt-viz lab discoverability via standard lab registration path.
- Reduces documentation drift and misleading naming in touched systems.
- Removes dead config to reduce source-of-truth ambiguity.
- Keeps follow-up small and easy to verify/merge.

### Negative

- Does not resolve every historically raised review comment.
- Leaves two design-level behavior concerns for future work.

### Risks

- Deferring behavior-level comments may leave latent gameplay concerns until a later PR addresses them.
- Removing the legacy Floor 1 config file could surprise contributors who still
  expect the old pre-manifest layout to exist.

## Alternatives Considered

1. **Fix every reviewed item immediately in one patch.** Rejected: mixes low-risk cleanup with behavior-changing work and increases regression risk.
2. **Do nothing post-merge.** Rejected: leaves at least one concrete functional issue (`bt-viz` registration) unresolved.
3. **Reopen PR #150 instead of follow-up PR.** Rejected: PR #150 is already merged; a small forward patch is clearer.
