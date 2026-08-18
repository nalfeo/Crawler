# Handoff: Assessed safe-room route recovery — rewrite not authorized

**Outcome: the safe-room route constraint is unlanded and not superseded, but its
pathology does not currently reproduce; do not rewrite without fresh evidence.**

## Date

2026-08-17

## Persona

Systems Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance

## Apples

1 apple: investigation and durable decision record only. A future implementation
would be approximately 5 apples.

## Assessment

The preserved but deliberately unmerged branch
`origin/nalfeo-safe-room-route-constraint-foundation` adds a post-selection,
door-aware exit prefix: after any semantic intent has selected a target outside
the current safe room, it temporarily supplies legal exit movement without
overwriting that intent's decision target.

This is **not** superseded by `src/game/ai/settlement-return-router.ts`. The
settlement router elects an optional goal to return to the Floor 2 settlement;
the abandoned constraint would instead shape movement for every already-selected
external intent. Future work must not treat these as duplicate features.

The current `LeaveSafeRoom` behavior-tree owner remains a known-inferior
architecture: it owns a latched egress waypoint and uses boundary-flicker
hysteresis/watchdog patchwork, rather than separating semantic ownership from
route geometry. However, it is architectural debt with unproven current impact,
not an authorized rewrite target.

## Current-main evidence

A current-main local panel found no reproduction of the historical doorway
timeout signature:

- `sword@14`, `bow@91`, `baseball-bat@35`, and `bow@2` each completed as
  `VICTORY` rather than reaching the 300-second timeout cap.
- `tests/headless/floor1-safe-room-egress-seed2-bow.test.ts` passed all 3
  focused assertions.

This is deliberately **not currently reproducible**, not proven gone. The
current runs do not expose the old branch's route-lifecycle telemetry, and the
focused regression only covers one patched owner-node case. Reconsider the
constraint only if a fresh rate sweep or a new deterministic repro demonstrates
a generic safe-room exit failure.

## Branch and drift correction

This branch surfaced during a 1,126-branch audit. Its apparent "819 commits
ahead" count is misleading: 819 commits occur after its merge base, but only 13
are unique to the branch; 806 are already shared with main. Main is 737 unique
commits ahead. The remaining unlanded payload is 20 files with 4,097 insertions
and 298 deletions, including the constraint reducer, tests, ADR, and a focused
rate gate.

Do not mechanically rebase or cherry-pick it. The present integration seams have
changed substantially, especially `bt-ai-provider.ts`, `headless-runner.ts`,
`types.ts`, `ai-sweep.yml`, and `behavior-tree-ai.test.ts`. If evidence ever
authorizes this work, rewrite it against current contracts and validate it with
a new GitHub-backed rate gate rather than reusing its historical baseline.

## Design reference

The branch remains preserved as evidence and design reference:

- Branch: `origin/nalfeo-safe-room-route-constraint-foundation`
- ADR:
  `docs/knowledge/adr/2026-07-13-safe-room-route-constraint-layer.md` on that
  branch

The historical implementation was mature but not proven at rate: its final
required 600-run cloud rerun was still outstanding when it was abandoned.
