# Session Handoff: Floor 4 slice 3 — deterministic waves

## Date

2026-08-27

## Persona

Producer → Game Designer (Floor 4 epic, slice 3 of 8)

## Systems touched

mapgen, ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual. Matches the adversarial plan review ledger
(`docs/knowledge/review-ledgers/2026-08-27-floor4-slice3-waves.review-ledger.json`):
new data pack + strict schema, a pure seeded manifest builder, wave release/cap/debt/cut
inside the existing director, lab tunables, and four test files.

## What Was Done

Implemented slice 3 of `.specify/specs/floor4-arena.md` — the wave windows are now
physical. Floor 4 was an empty rehearsal arena; it now fills through its feed gates on
a seeded schedule and empties at the boundary.

- **Enemy pack.** `src/shared/data/enemies.floor4.json` (`floor4-arena`: extra, usher,
  pyro-tech, stunt-double, ring-enforcer) registered through `enemy-packs.ts`. Every
  archetype has `spawnWeight: 0` — the pack is director-driven only and can never be
  ambient-rolled.
- **Authored schedule.** A strict `floor4.waves` manifest block (cadence, budget curve,
  concurrency caps, gate telegraph lead, per-act rosters with threat costs/weights) with
  cross-field validation: pack must exist, `actMultipliers` must cover every act, the
  last wave must release before the window closes, `liveCap` must fit the pack's
  `enemyCap`, and rosters must list acts 1..N exactly once using real archetype ids.
- **Immutable manifests.** `src/shared/floor4-waves.ts` composes each wave from its own
  derived stream `<seed>:floor4:waves:<act>:<waveIndex>` (FR7.1/FR7.2) and freezes the
  result. Budget follows FR3.3: `base × actMultiplier × (1 + intraActRamp × waveIndex)`,
  with act 1 wave 0 additionally scaled by `openingWaveMultiplier` (design §5.1's
  deliberately tiny opener).
- **Release, cap, debt, cut** live in the existing `arenaDirectorSystem` slot — no second
  system (`check:wired-systems` still reports 55 systems, all wired). Entering `WAVES(act)`
  arms that act's manifests; the director releases due waves in order, spawns at
  `FloorMap.feedGates` in manifest order, holds the live cap, banks overflow as bounded
  FIFO spawn debt, and discards anything past `debtCap` (counted in telemetry).
- **The cut (FR3.6).** At the wave-window boundary every surviving owned enemy is removed
  via `clearEntityStores` + `removeEntity` — health is never zeroed, so `dropSystem` never
  runs: no XP, no gold, no drops, no `death` combat event, no kill credit. Each cut pushes
  a `deathPop` VFX (tinted with the entity's blood color) so it reads as an intentional
  exit rather than entities blinking out.
- **Gate telegraphs.** Gates arm `telegraphLeadMs` before their wave releases (state on
  `Floor4WaveWindowState.armedTelegraphs` + a `spawnerPulse` VFX per gate), disarm on
  release, and are discarded — along with banked debt — at every phase transition (FR3.5).
- **Lab.** `floor4-arena-lab` now exposes waves/act, interval, budget base, per-act
  multiplier, intra-act ramp, opening multiplier, live cap, debt cap and telegraph lead
  through lil-gui, previews the real `buildFloor4ActWaveManifests` output per act/seed, and
  shows live wave/debt/cut/telegraph counters. The knobs hot-patch the in-memory manifest
  so preview and live director always read the same numbers; teardown restores the
  authored block.

**Observed in a real headless artifact** (`BehaviorTreeAI`, 200 s horizon):

|          | before (slice 2)                         | after (slice 3)                                                                                                 |
| -------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| seed 404 | empty arena, 0 enemies, victory at 600 s | 15 waves released, 63 spawned, 29 killed, 10 cut, 0 debt discarded, 43 gates lit; alive in act 2 at the horizon |
| seed 777 | empty arena, 0 enemies                   | 15 waves released, 72 spawned, 41 killed, 14 cut, 0 debt discarded, 44 gates lit                                |

Same-seed reruns reproduce timeline and wave telemetry field-for-field.

## Key Decisions Made

- **Content and release state are separate.** Manifests are frozen content built once per
  act; the cursor, debt, armed telegraphs and ownership map are mutable state in
  `Floor4ArenaState`. Cap pressure can therefore never re-roll a wave.
- **No RNG anywhere in the live path.** Release, debt, gate stagger and the cut are pure
  functions of already-composed content, so a player's pace cannot shift a seed's later
  draws. A test wraps `world.rng.next`/`nextInt` and asserts zero calls across a whole act
  including the cut.
- **Gate stagger is content-derived, not searched.** Spawn offset is `slot % 3` half-tiles
  inward from the gate tile, with an `isPassableAt` fallback to the tile center — a retry
  or jitter search would make placement path-dependent.
- **Overflow is dropped, not deferred.** Debt beyond `debtCap` is discarded and counted,
  because a deferred backlog would discharge as an unsurvivable burst right after the cap
  frees up.
- **The empty-arena headless completion test was replaced, not weakened.** Its victory
  assertion was only true because nothing spawned; that contract is now false by design.
  `tests/headless/floor4-arena-waves.test.ts` covers the same pipeline with wave-window
  assertions, and it keeps the `safeRoomMs ≥ countdownMs` check. The full
  `COUNTDOWN → … → VICTORY` rehearsal timeline is still asserted in
  `tests/unit/floor4-arena-director.test.ts`.

## What's Next / Blockers

- **Slice 4+** (Headliners, Green Room shops, HUD) hangs off the same director slot. The
  rehearsal auto-clear headline / auto-advance intermission is still in place underneath.
- **Balance is explicitly not tuned here** (slice 7 owns it). Current act-1 seeds compose
  ~26 enemies across 8 waves; act 5 saturates the live cap and discards debt, which is the
  intended pressure shape but not a validated difficulty curve.
- Floor 4 has `implemented.mvp: false`, so it is outside the sweepable set and the Floor-1
  90% win-rate gate is unaffected by this change.

## Retrospective

### Lessons Learned

- The "idle provider" trick for isolating director behavior in headless is imperfect: the
  runner's baseline reflexes still land hits, so kills are low but not zero. The exact
  "the cut pays nothing" claim belongs in a unit test where kills are provably zero; the
  headless test asserts the weaker accounting identity (`kills + cut ≤ spawned`).
- `enemyDamageMultiplier` cannot be used to neutralize enemies in a headless test — it
  clamps to a minimum of 1.
- Driving the director with coarse `advance(waveWindowMs)` steps transitions phases without
  ever servicing the window, which is exactly why the pre-existing slice-2 phase tests kept
  passing unchanged after waves went live.

### Mistakes Made

- Wrote the headless test asserting `totalKills === 0` before checking whether an idle
  provider can still kill. Early signal: the run reported 520 damage dealt. Probe the
  harness's actual behavior before encoding an assumption about it.
- Initially left `slot` off `Floor4PendingWaveSpawn` after deciding the gate stagger should
  be content-derived; the typecheck caught it, but the design decision should have been
  written into the type first.

### Opportunities for Future Improvement

- The cut currently emits one `deathPop` per enemy. With a saturated act-5 cap that is ~24
  simultaneous pops; a dedicated "house lights" cut effect would read better than 24
  death pops and is a natural UX-designer follow-up.
- `Floor4WaveTelemetry` is per-run cumulative. Per-act breakdowns would make slice 7's
  difficulty-curve work much easier to evidence.
