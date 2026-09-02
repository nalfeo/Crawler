# Session Handoff: Goobers shadow-mode parity

## Date

2026-09-02

## Persona

Producer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Added a read-only Goobers shadow workflow and parity utility to generate deterministic decision artifacts for CI Recovery and Merge Train decisions, without mutating repository state. The workflow writes a JSON artifact under `.goobers-shadow/`, attaches an idempotency key, and keeps the parity status explicit (`clean` vs `divergence`). Also extended the Goobers contract validator to admit the new workflow and the shadow-specific output fields.

## Key Decisions Made

- Shadow mode stays read-only and intentionally never issues write-capable GitHub tokens or mutation commands.
- Parity is computed on normalized decisions rather than raw log text so duplicate replays remain deterministic.
- The parity helper uses a stable SHA-256 idempotency key to avoid duplicate shadow artifacts being treated as new decisions.

## What's Next / Blockers

Next phase is to wire the shadow workflow into live trigger coverage and schedule a soak window; the current implementation is the deterministic read-only gate, and it remains intentionally non-mutating until parity is proven in the operating environment.

## Retrospective

### Lessons Learned

The repo already had dry-run safety for CI Recovery and Merge Train, but it lacked an explicit deterministic shadow-mode artifact path and parity contract. Normalizing on business-level decision fields avoids replays and noisy log diffs while keeping the guard readable.

### Mistakes Made

None significant; the main risk was overbuilding the artifact contract. The implementation keeps it compact and deterministic to match the Phase 1 requirement.

### Opportunities for Future Improvement

The next session can expand the shadow replay dataset beyond the representative CI Recovery / Merge Train fixture set and feed a daily summary into a repository report.
