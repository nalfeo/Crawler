# Handoff: Orthogonal PR Change-Impact Classification

**Date:** 2026-07-19  
**Session slug:** orthogonal-change-impact-classification  
**Issue:** #1688  
**Apple estimate:** 3🍎 actual: 3🍎  
**PR:** (opened at end of session)

## Systems touched

ci, scripts

## What was done

Extended `scripts/agent/ci/detect-art-only.sh` and `scripts/agent/ci/local-scope.sh` with five new **independent, fail-closed** output flags:

| Flag                      | Positive when                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------- |
| `visual_touched`          | `src/engine/**`, `src/labs/**`, `public/**`, `src/shared/data/sprite-catalog.json` |
| `sim_touched`             | `src/core/**`, `src/game/**`, `src/shared/**` (non-catalog), `tests/headless/**`   |
| `coverage_touched`        | `src/**`, most `tests/**` (excludes e2e, sprite-specific tests)                    |
| `sprite_pipeline_touched` | Derived from existing `sprites_touched` flag                                       |
| `dependencies_touched`    | `package.json` (dep sections), `package-lock.json`                                 |

**Unknown/unclassified paths** → all potentially-relevant flags set to `true` (fail-closed).  
**Neutral companion files** (handoffs, review ledgers, metrics JSON, other docs) → all flags remain `false`.

## Key design decisions

1. **`package_json_deps_changed()` tri-state**: exit 0=deps changed, 1=no dep sections changed, 2=unknown. Captured with `|| pkg_deps_rc=$?` under `set -euo pipefail`. Unknown → fail-closed (dependencies_touched=true).

2. **Case statement ordering**: `src/shared/data/sprite-catalog.json` precedes `src/shared/*` in all loops (specific before broad). Sprite test directories precede generic `tests/**` in the sim_touched neutral list.

3. **`package-lock.json`**: hits `*)` unknown case in visual/sim/coverage → all three true (fail-closed). Explicitly positive in dependencies_touched loop.

4. **`sprite_pipeline_touched="$sprites_touched"`**: directly derived to avoid duplicating the sprite allowlist.

5. **Backward compatibility**: the existing 5 flags (`art_only`, `docs_only`, `gameplay_safe`, `sprites_only`, `sprites_touched`) are unchanged in semantics and position; `emit_all()` extended from 5 to 10 args.

## Files changed

- `scripts/agent/ci/detect-art-only.sh` — core classifier (5 new loops, `package_json_deps_changed()`, `emit_all` extended to 10 args)
- `scripts/agent/ci/local-scope.sh` — `emit_all_false()` now prints all 10 flags
- `.github/workflows/ci.yml` — 5 new outputs, schedule override vars, echo lines
- `tests/unit/detect-change-scope.test.ts` — 47 table-driven tests (extended Scope, F(), run())
- `tests/unit/local-scope.test.ts` — 9 working-tree integration tests (extended Scope, F() with overrides)
- `docs/knowledge/review-ledgers/2026-07-19-orthogonal-change-impact-classification.review-ledger.json` — review ledger

## Review harness

- Plan review: gpt-5.4 — 7 concerns (4 blocking, 3 minor), all resolved before implementation
- Code review (round 1): claude-opus-4.7 — 0 concerns, clean

## Acceptance criteria status

- [x] Unknown paths → all relevant `*_touched` flags = true
- [x] CI/tooling-only changes → `visual_touched=false`, `sim_touched=false`
- [x] Generated game art → `visual_touched=true`, `sim_touched=false`
- [x] Core/game/shared sim changes → `sim_touched=true`
- [x] Dependency manifest changes → `dependencies_touched=true`
- [x] Neutral companion docs don't broaden unrelated flags
- [x] Deletions, renames, mixed diffs, empty diffs covered (existing + new tests)
- [x] Table-driven deterministic tests document representative path classes (47 cases)
- [x] Existing consumers remain compatible (5 original flags unchanged)

## What's next

Dependent issue #1684 can migrate heavy-job gating to use the new `*_touched` flags to skip more jobs on narrower change sets.
