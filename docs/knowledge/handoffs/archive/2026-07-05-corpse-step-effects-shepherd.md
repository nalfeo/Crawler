# Session Handoff: Corpse-step burst + player trail shepherd (PR #782)

## Date

2026-07-05

## Persona

Producer (PR Shepherd)

## Systems touched

vfx, enemies, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact — 2 real blockers + plan-review
hardening + full 3-apple review harness + cross-layer ADR, no surprise
scope creep).

## What Was Done

Took over PR #782 ("feat: corpse step burst chance + player movement
trail", branch `feat/corpse-step-effects`) as shepherd after the original
owner went idle. Two real failing checks were the only blockers (unit /
integration / types / lint / e2e all passed); drove both to green
legitimately and ran the apple-scaled review harness to a valid ledger.

### BLOCKER 1 — Format & Labs (missing lab)

The PR added a new `corpseStepSystem` in `src/core/systems/` with no lab,
violating the hard "every system needs a lab" rule. Created
`src/labs/corpsestep-lab/` (`index.ts` + `README.md`) — a canvas-2D lab
that drives the **real** `corpseStepSystem`, showing regular corpses
bursting on step and a green "NEST" spawner corpse that is excluded.
Registered it in `src/lab-main.ts` (`LAB_MODULE_PATHS`). Lab dir name
`corpsestep-lab` matches the gate's expectation for `corpseStepSystem`.
`npm run check:wired-systems` stays green — `corpseStepSystem` is wired
into both real pipelines, not just the lab.

### BLOCKER 2 — Headless Floor 1 Gate (arena-lockin sweep 88% < 95%)

**Root cause:** the `rats-nest` spawner is tagged `Enemy` and lingers via
`DeathTimer` on death, so it matches the corpse query. Spawner death is a
multi-tick handshake (`spawnerSystem` sets `deathResolved` the tick after
`hp<=0`; `spawnerArenaSystem` then flips `LOCKED → RESOLVED` and unseals
the room). The corpse-step burst reaped the spawner's lingering corpse
early — zeroing its `DeathTimer` so `deathTimerSystem` destroyed the entity
before the handshake finished — orphaning the locked arena so the room
never unsealed. Seed 1's 10% roll landed on the spawner corpse →
`tests/headless/ai-arena-lockin-resolution.test.ts` dropped to 88% (7/8),
below the 95% floor. Sword/bow/bat win-rate gates stayed green, confirming
this was arena-resolution interference, not a balance shift.

**Fix (two-layer Spawner exclusion, determinism-neutral):**

1. `corpseStepSystem` skips `Spawner` corpses at the feature boundary
   (`if (hasComponent(world.ecs, eid, Spawner)) continue;`) — first check in
   the corpse loop, before the trigger roll.
2. `applyDamage` (`src/core/apply-damage.ts`) returns `0` for a `Spawner`
   target in the corpse branch, _before_ emitting the explosion or zeroing
   the timer — the shared choke point that protects the linger invariant
   from ALL damage sources (projectile/melee/AoE/beam), added during plan
   review (see below).

Both guards return before any `world.rng.next()` call (the corpse branch
already returned before the dodge/crit rolls), and the corpse-step roll
uses `hashStringToSeed(seed:frame:eid)` — never `world.rng` — so the fix is
determinism-neutral and does not perturb the seeded gameplay stream
(rule #13). `CORPSE_STEP_TRIGGER_CHANCE = 0.1` is untouched (rule #12).

### Review harness (3🍎: plan_review + code_review loop)

- **plan_review** (rubber-duck, gpt-5.4, high) → approved_with_changes, 2
  non-blocking concerns, both adopted: (1) guard `Spawner` at the shared
  `applyDamage` choke point, not just the footstep path (this is where the
  layer-2 guard came from); (2) add deterministic regression coverage that
  the arena handshake survives a burst on the spawner corpse.
- **code_review** (code-review agent, claude-sonnet-4.6) → round 1 clean,
  no significant issues across entity-recycling/WeakMap correctness,
  hash-roll determinism, the two-layer guard, pipeline wiring+ordering,
  `PlayerTrailVfx` sim isolation, and render-depths.
- Ledger: `docs/knowledge/review-ledgers/2026-07-05-corpse-step-spawner-exclusion.review-ledger.json`
  — validates as a valid 3-apple ledger (exit 0).

### Coverage added

- `tests/unit/corpse-step.test.ts` — spawner-never-bursts (1000-iter) +
  co-located regular corpse still bursts.
- `tests/ecs/corpse-explosion.test.ts` — `applyDamage` never detonates a
  Spawner corpse; never reaps it the frame it is hit.
- `tests/integration/spawner-arena.integration.test.ts` — a burst hit on
  the lingering spawner corpse still lets a LOCKED arena reach RESOLVED
  (drives real `spawnerArenaSystem` + `applyDamage` + `deathTimerSystem` +
  `spawnerSystem`).

## Observe before done (real artifact, rule #10)

Validated on the REAL headless pipeline
`tests/headless/ai-arena-lockin-resolution.test.ts` (uses
`runSimulationStep` from `src/game/ai/simulation-step.ts`), NOT a lab:

- **Before fix:** `resolved 88% (7/8) below 95% floor — misses:
[1:unresolved after 60s]`.
- **After fix:** `1:R@331f 2:R@403f 3:R@295f 4:R@439f 5:R@259f 6:R@259f
7:R@331f 8:R@295f — rate 100%` (8/8). Seed 1 now resolves at frame 331.

`verify:fast` green throughout (1060 tests in scope after the new tests).

## Key Decisions Made

- **Corpse-bursting is a real gameplay state change, not cosmetic** — the
  timer-zero consumes the entity; documented so future necromancy can treat
  corpses as a finite consumable resource. See ADR
  `2026-07-05-corpse-step-real-gameplay-burst.md`.
- **Two guard layers kept deliberately** (defense in depth): feature-boundary
  guard in `corpseStepSystem` (semantics + skip wasted roll) + shared
  choke-point guard in `applyDamage` (protects the invariant from every
  damage source).
- **Cross-layer ADR required** — diff spans `src/core` + `src/engine` +
  `src/game`, so an ADR documents the corpse-state + two-layer decision.

## Files Touched

- `src/core/systems/corpseStepSystem.ts` — layer-1 Spawner skip + framing doc.
- `src/core/apply-damage.ts` — layer-2 Spawner guard at the corpse choke
  point + doc rewrite on `emitCorpseExplosion`.
- `src/shared/combat-events.ts` — `corpseExplode` doc reflects real state change.
- `src/labs/corpsestep-lab/{index.ts,README.md}` — new lab (BLOCKER 1).
- `src/lab-main.ts` — registered the lab.
- `tests/unit/corpse-step.test.ts`, `tests/ecs/corpse-explosion.test.ts`,
  `tests/integration/spawner-arena.integration.test.ts` — new coverage.
- `docs/knowledge/adr/2026-07-05-corpse-step-real-gameplay-burst.md` — ADR.
- `docs/knowledge/review-ledgers/2026-07-05-corpse-step-spawner-exclusion.review-ledger.json` — ledger.
- Base PR (pre-shepherd): `PlayerTrailVfx.ts`, `PhaserBridge.ts`,
  `render-depths.ts`, both `simulation-step.ts`, `core/systems/index.ts`.

## What's Next / Blockers

- None functional. Arena gate 100%, review harness complete, ledger valid.
- **Future corpse-consuming systems (necromancy, harvesting) must skip
  `Spawner` corpses** or route reaping through `applyDamage`, or they will
  reintroduce the orphan-arena bug. Noted in the ADR risks.
- If `Spawner` is ever reused for a steppable entity, the two guards need a
  narrower predicate (gate on the arena/linger role, not the raw tag).

## Retrospective

### Lessons Learned

- A spawner tagged `Enemy` + `DeathTimer` silently matches the corpse query
  — any new system that touches "corpses" must consider spawner structures,
  because their linger is load-bearing for the arena handshake.
- The determinism win was that corpse-step uses `hashStringToSeed`, not
  `world.rng`; that plus the corpse branch returning before the RNG rolls
  made the guard provably determinism-neutral rather than "probably fine".

### Mistakes Made

- Initial fix guarded only `corpseStepSystem`. Plan review (gpt-5.4)
  correctly flagged that the shared `applyDamage` corpse branch could still
  reap a dying spawner from any other damage source — adopted the
  choke-point guard before writing more code. Signal: when a new feature
  reaches a shared mutation via a narrow entry point, check whether the
  invariant needs protecting at the shared point too.

### Opportunities for Future Improvement

- Floor 1's arena-lockin sweep is synthetic/barrier-armed; a real
  barrier-arming spawner in the sampled seeds would exercise this handshake
  continuously rather than only under the synthetic sweep.
