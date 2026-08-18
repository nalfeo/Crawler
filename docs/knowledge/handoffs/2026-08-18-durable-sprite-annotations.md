# Durable Sprite Editor annotations

**Date:** 2026-08-18  
**Persona:** DevOps Engineer  
**Apples:** 3 estimated / 3 actual

## Systems touched

sprite-workflow, sprite-editor, asset-queue

## What changed

- Added validated per-sprite annotation updates to `queue-commit`; each CAS retry
  merges only the requested keys into the freshly fetched `assets/queue` tip.
  The shared aggregate is never copied from a stale worktree.
- Queued annotation-only Sprite Editor saves, serialized editor queue requests,
  and guarded local cleanup with per-sprite versions and before/after byte checks.
- Kept failed queue edits in the tracked worktree and surfaced a durable-queue
  failure in both normal saves and the list favorite action.
- Added an untracked pending presentation overlay beside the existing manifest
  snapshot so a safely cleaned annotation remains visible until promotion reaches
  the worktree. Saving another sprite always starts from raw tracked data.
- Preserved the existing reconciler allowlist, stale-source filtering, source
  trailers, and lease/CAS cleanup. Annotation-only candidates now have explicit
  real-git promotion coverage.

## Deterministic evidence

- `npx vitest run tests/unit/sprites/queue-commit.test.ts tests/unit/sprites/queue-commit-cli.test.ts tests/unit/sprites/reconcile-queue.test.ts --reporter=dot`
  — 137 passed.
- `node --test ".github/extensions/sprite-editor/tests/*.test.mjs"` — 51 passed
  before the final real-git editor handoff case was added.
- `node --test .github/extensions/sprite-editor/tests/annotation-persistence.test.mjs`
  — 7 passed, including the production CLI handoff, clean git diff assertion, and
  staged-index safety.
- `npx vitest run tests/integration/generate-one.test.ts --reporter=dot`
  — 16 passed, including a queued dislike suppressing local reference selection
  before promotion.
- `npm run verify:fast` — 29 files / 509 tests passed; all integrity checks green.
- `npm run test:guards` — 2,487 passed, 40 skipped, 0 failed.
- `npm run docs:check` — passed after updating ADR 0070's renamed resolver and
  test references.

## Review

- Code review found a pending-overlay leak into the tracked aggregate, premature
  cleanup that hid queued dislikes from local reference selection, and stale index
  preservation after cleanup. `saveLocal` now reads the raw tracked document,
  local consumers load the pending overlay, and staged aggregate edits block
  cleanup before any mutation.
- The independent grade is recorded after the gradeable implementation commit.

## Remaining concerns

- None in the implementation. Publication/commit was explicitly left to the
  worktree owner.
