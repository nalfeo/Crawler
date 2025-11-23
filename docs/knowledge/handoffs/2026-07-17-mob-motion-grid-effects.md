# Session Handoff: Mob motion grid and projectile origins

## Date

2026-07-17

## Persona

Producer → Graphics Designer / Gameplay Engineer

## Systems touched

devtools, vfx, enemies, ai-behavior-tree

## Apples

5🍎 estimated, 5🍎 actual — exact

## What Was Done

Expanded the Mob Motion Lab from three clips into a deterministic 3×2 grid for
Spawn, Movement, Attack, Hit Reaction, Death/Corpse, and Status. Preview behavior
is archetype-first, so ranged and melee enemies retain different attacks even
when they share generated art. Ranged previews use the shipped hostile projectile
frame; melee/contact previews never synthesize one. The panel hierarchy, sprite
scale, and pixel-font rendering were also tightened after visual review.

Aligned the lab and real game on one hostile-projectile origin contract:
projectiles start at the exact ECS/visual pivot. Immediate fire uses the current
pivot; telegraphed fire uses the locked pivot even if the shooter moves. The BT
virtual-threat model now uses the same origin. Removed the obsolete 1.5 ft muzzle
offset from constants, tuning, runtime spawning, and AI prediction.

Matched the Death/Corpse cell to the existing runtime presentation: death pop,
knockback, blood pool, upright corpse, rising skull, desaturation, and fade over
the shared `CORPSE.LINGER_MS` duration. `dropSystem` now uses that shared
three-second constant.

Observed in the real headless pipeline through
`tests/integration/enemy-projectile-origin-pipeline.test.ts`: before, runtime code
spawned 1.5 ft ahead of the telegraph pivot; after, immediate fire was observed at
`(100, 0)` and delayed fire stayed at locked `(100, 0)` after the shooter moved to
`(140, 20)`. In the live lab at
`http://127.0.0.1:5301/lab.html?lab=mob-motion-lab`, a ranged archetype showed its
projectile exactly at the locked pivot on release while a same-art melee
archetype reported no projectile.

## Key Decisions Made

- Behavior keys off enemy archetype/AI type, then selects an art variant. Brief
  identity cannot safely imply combat behavior because multiple archetypes share
  briefs.
- Exact ECS/visual pivot is the deterministic fallback for hostile emissions.
  Generated `hold` anchors are attachment points, not reliable muzzle points.
- A generic weapon anchor is intentionally deferred to issue #1247; it must
  support visible ranged and melee weapons, define mirroring, and fall back to
  the pivot.
- Telegraph origin, projectile spawn, and BT prediction remain synchronized.
  Accuracy draw order, cooldowns, projectile velocity, and telegraph timing did
  not change.
- The runtime corpse contract is reused rather than creating a lab-only collapse
  animation.

## What's Next / Blockers

- CI should run the normal gameplay gates. A paired 100-seed × 3-weapon GitHub
  sweep should compare the pre-change branch with this branch because projectile
  origins can affect headless outcomes.
- Issue #1247 owns generic weapon-anchor metadata/editor/runtime work.
- No implementation blocker remains. Deterministic visual geometry is clean; the
  dev-only LLM visual judge oscillated between unrelated spacing findings after
  measured fixes, so its latest report remains advisory rather than a code gate.

## Retrospective

### Lessons Learned

- Shared sprite briefs require archetype-first preview semantics; art-first
  selection silently merges distinct combat contracts.
- A telegraph is only truthful when its visual origin, eventual spawn position,
  and AI threat prediction share the same locked data.
- Global `border-box` styling can scale a Canvas backing store by its border
  width. Explicit `content-box` sizing keeps the 960×660 pixel surface crisp.
- A pipeline observer appended after canonical `preSystems` and before movement
  is a precise way to verify raw projectile spawn coordinates.

### Mistakes Made

- The first design inferred attack behavior from generated briefs. The early
  signal was `goblin-grunt` and `goblin-junkshot` sharing art while requiring
  melee and ranged behavior; adversarial review caught the mismatch.
- The first Death cell invented a collapse that contradicted the shipped corpse
  lifecycle. Comparing against `dropSystem` and `PhaserBridge` earlier would have
  prevented the rework.
- Initial projectile thinking treated generated `hold` anchors as possible
  muzzle data. Inspecting their center/feet distribution showed that contract was
  unsuitable.
- The first visual-review setup used an abbreviated archetype id and the first
  command followed an obsolete runner example. The live probe's exact id and the
  current skill command should have been checked before execution.

### Opportunities for Future Improvement

- Expose stable panel bounds and typography metrics directly from lab probes so
  visual-review setup scripts do not duplicate design constants.
- Improve visual-review finding identity/adjudication so numerically rebutted
  geometry findings do not return under new wording on each pass.
- Promote the future weapon-anchor contract into one shared editor/manifest/
  renderer type rather than introducing ranged-only muzzle metadata.
