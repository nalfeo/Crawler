# Session Handoff: Restore missing gore VFX (blood pools + corpse "body explosion")

## Date

2026-07-02

## Persona(s) adopted

**Engine/Rendering specialist** (bridge + VFX). The report was a pure render-layer
regression ("effects disappeared") with combat/ECS emission intact, so the work
lived entirely in `src/engine/` VFX draw paths plus their regression tests. No
Producer split was needed — single layer, single root cause.

## Routing verdict

✅ right persona — the symptom (VFX vanish) and the fix (feet→pixel conversion at
the render boundary) are squarely engine/rendering; no game-core or ECS changes.

## Apples

Estimated: 🍎 x 1 <!-- declared before work began -->
Actual: 🍎 x 1
Verdict: 🎯 Exact — surgical, well-understood single-layer coordinate fix in two
draw sites + deterministic tests; the only surprise (3 pre-existing sprite-test
typecheck errors surfaced by full `tsc`) was trivial union-narrowing, not added
complexity.

Hello kitties: 1/5 = 0.20 🎀

## Systems touched

enemies

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-fix-missing-gore-effects.review-ledger.json`
Stages (1🍎 tier): code_review ✅
`npm run review:ledger -- validate <path>` → ✅ valid 1-apple ledger.
Code-review agent (claude-sonnet-4.6) round 1: **0 concerns** — verified both
conversion sites, grepped every other `scene.add.*` engine VFX path for missed
conversions (none), confirmed no double-conversion, checked `CorpseShatterVfx`
downstream units, and re-ran the new regression tests. Clean on first round.

## What Was Done

Root cause: the #366 refactor ("feet as the single internal spatial unit",
commit `f347dbd4`) made internal coordinates **feet** and added `ftToPx()` (×8,
`PIXELS_PER_FOOT = 8`) at the render boundary — but **missed two draw paths**, so
they drew feet values as pixels and rendered at ~1/8 scale near the top-left
origin (i.e. "disappeared"):

1. **Blood pool** — `GoreVfx.spawnBloodPool` (from #280) drew the ellipse centre
   at raw feet. Fixed to `ftToPx(spawnX)` / `ftToPx(spawnY)`; size/jitter
   constants were already pixel-space and left untouched.
2. **Corpse shatter ("body explosion")** — the `PhaserBridge` `pendingShatter`
   push passed raw `event.x/event.y` (feet). Fixed to `ftToPx(event.x/y)` at the
   bridge boundary, consistent with every other coordinate there; kept
   `CorpseShatterVfx` pure pixel-space (only its doc comment updated).

Deterministic regression tests (`tests/unit/vfx-world-coords.test.ts`) assert
both VFX land at `ftToPx(deathPos)`. Proven load-bearing via git-stash: they FAIL
on pre-fix source, PASS after (rule #10 before/after in a headless artifact).

Also fixed 3 pre-existing sprite-test typecheck errors that the full `tsc` gate
surfaced (rule #8): a union-narrowing issue in `asset-queue.test.ts` and an
invalid `Record<string, unknown>` cast in `issue-pipeline.test.ts`.

### On "gore lab has no way to trigger the follow-up hit"

Confirmed by design, not a bug: `weaponSystem.ts` targeting intentionally skips
corpses (DeathTimer / HP ≤ 0), so the lab's auto-fire can't re-hit a corpse. But
`meleeSwingSystem` and projectile collisions **can** overlap corpses in real
gameplay, so the corpse-explode path is reachable — and the `corpseExplode` event
carries its own sprite metadata, so the bridge handler works even after the
target's live visual is gone. No code change needed for this observation.

## What's Next

- Create the PR (handoff + ledger + apple JSON committed first), run
  `verify:pr-prereqs`, then `create_pull_request`.
- Optional follow-up (out of scope): give the gore lab an explicit "hit corpse"
  affordance so the follow-up-hit / corpse-explode path is manually triggerable
  in-lab without relying on melee/projectile overlap.

## Blockers

None. Fix complete and verified.

## Branch State

- Branch: `nalfeo-fix-missing-gore-effects`
- All tests passing: yes
- PR created: no (next step)

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": { "crash": 2 },
    "ctx": { "allow": 1 },
    "ctx-a": { "allow": 1 },
    "ctx-b": { "allow": 1 },
    "edit-bad": { "bypass": 1 },
    "edit-guard-self-protection": { "ask": 2 },
    "pr-a": { "deny": 1 },
    "pr-b": { "deny": 1 },
    "pr-hard": { "deny": 1 },
    "pr-warn": { "allow": 1 },
    "shell-a": { "deny": 1 },
    "shell-bad": { "deny": 2 }
  },
  "tools": { "create_pull_request": 4, "edit": 6, "powershell": 5 }
}
```

> Note: these are guard **unit-test fixture** events from the guard test suite run
> during `verify`, not live session enforcement decisions.

## Test Results

- `npm run typecheck` (full `tsc`): clean
- `npm run verify:fast`: green
- `npm run verify`: green — 2823 unit + 49 integration + 17 headless Floor-1
  tests pass; build OK. (Only Step 9 `verify:pr-prereqs` was pending on the
  handoff + ledger, now satisfied.)

## Key Decisions Made

- **Where to convert.** Corpse-shatter converts at the **bridge boundary**
  (matching every other coordinate the bridge hands to a VFX renderer), keeping
  `CorpseShatterVfx` pure pixel-space. Blood pool converts **inside** `GoreVfx`
  because it reads live interpolated world positions itself via
  `resolvePosition()` (like the gore particles, which #366 did convert). Only the
  centre x/y convert; sizes/jitter are already pixel-space.
- **Rule #10 observation via deterministic test** rather than a live screenshot:
  the lab's dark radial background made pools hard to see by eye, and the rules
  explicitly prefer promoting a visual-bug class into a deterministic headless
  check. git-stash before/after proved the guard tests are load-bearing.

## Retrospective

### Lessons Learned

- A "single internal spatial unit" refactor (#366) is a classic source of
  **partial-conversion** bugs: the common paths got `ftToPx()` but two rarer draw
  sites (a blood pool added in a different PR, and a hand-off push) were missed.
  When auditing this class, grep **every** `scene.add.*` in the engine and check
  each coordinate arg for the conversion — don't assume the refactor was total.
- The 47 existing gore/corpse/vfx unit tests all passed through the regression
  because their mock scenes don't assert coordinates. Coordinate-correctness
  needs a test that actually checks the drawn x/y against `ftToPx(expected)`.
- Full `npm run typecheck` (whole-project `tsc`) catches errors that
  `verify:fast` (changed-files scope) silently skips — run it before assuming the
  tree is clean.

### Mistakes Made

- Initially tried to eyeball the fix in the running lab; the dark background made
  the ~1/8-scale pools near the origin ambiguous. Early signal I should have
  trusted sooner: `PIXELS_PER_FOOT = 8` + "appears near top-left" ⇒ it's a
  missing unit conversion, provable deterministically — skip the screenshot hunt
  and write the coordinate assertion first.

### Opportunities for Future Improvement

- Consider a lint/test guard that flags a `scene.add.*` call in `src/engine/`
  using a coordinate not passed through `ftToPx()` (or a typed `Feet`/`Pixels`
  brand on the units), so the next partial-conversion regression fails CI
  automatically instead of visually.
- Give the gore lab an explicit corpse-hit affordance (see "What's Next") so the
  corpse-explode path is manually exercisable in isolation.
