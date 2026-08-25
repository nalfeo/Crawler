# Session Handoff: Floor 4 slice 3 — deterministic waves, cap, debt, cut

## Date

2026-08-25

## Persona

Producer → Systems/Game/QA Engineer (Floor 4 epic, slice 3 of 8)

## Systems touched

enemies, ai-combat-balance, mapgen

## Apples

4🍎 estimated, 4🍎 actual. Scope held: one authored enemy pack, a manifest block with
cross-registry validation, shared types/telemetry, a core tag component, a pure
scheduling module, a director rewrite, lab readouts, three test files, ADR, spec update,
and the tier-4 review ledger.

## What Was Done

Implemented slice 3 of `.specify/specs/floor4-arena.md` (FR3.1–FR3.7, FR7.1–FR7.2):

- `src/shared/data/enemies.floor4.json` — the `floor4-arena` pack (usher, intern,
  camera-op, pyro-tech, stagehand-elite), registered in `enemy-packs.ts`.
- `floor4.waves` manifest block: budget curve, per-act rosters with integer threat
  costs, concurrency cap, debt cap, telegraph lead, gate slot spacing — plus a strict
  Zod schema that cross-validates the pack id and every roster archetype against the
  enemy-pack registry and checks cadence/telegraph/affordability invariants.
- `src/game/floor4/wave-manifest.ts` — pure, seeded manifest generation keyed on
  `(floorSeed, 'floor4', 'waves', act, waveIndex)`, plus the budget curve and an
  order-sensitive fingerprint.
- `arenaDirectorSystem` rewritten from a per-tick switch into a **bounded chronological
  boundary loop** that fires telegraphs, releases waves through a release cursor, holds
  the concurrency cap, defers overflow to a capped spawn-debt queue, clears debt on every
  phase transition, and applies the cut when a wave window ends.
- `ArenaWaveEnemy` tag component for cut-safe wave ownership.
- Gate spawn slots enumerated and walkability-validated once at floor init.
- `Floor4ArenaRunStats` wave telemetry + per-act manifest fingerprints (flows to both
  headless and human run-stats collectors automatically).
- `floor4-arena-lab` now prints manifests, live/cap, debt, cut and telegraph state.

## Key Decisions Made

See ADR 0093 for the full rationale. Headlines:

- Extend the already-wired `arenaDirectorSystem` instead of adding a `*System` (no new
  rule-#14 wiring surface, phase authority stays single).
- Manifests are rolled once per act and never re-rolled; release consumes zero RNG.
- Integer threat costs make the budget spend loop structurally terminating.
- Wave ownership is an ECS tag, not an EID set (bitecs recycles EIDs).
- The cut emits `deathPop` VFX only — a combat `death` event would be counted as a kill
  by the headless runner — and skips entities already dying this frame so it cannot race
  `dropSystem`.

## Observe Before Done (rule #9)

Real artifact: headless Floor 4, seed 404, `BehaviorTreeAI`.

- **Before:** Floor 4 spawned no enemies at all (empty slice-2 rehearsal); an idle
  provider reached `VICTORY`.
- **After, act 1 (93 s):** `wavesReleased: 8, enemiesScheduled: 64, enemiesSpawned: 64,
gateTelegraphsFired: 28`.
- **After, 250 s (acts 1–3):** `wavesReleased: 17, enemiesScheduled: 165,
enemiesSpawned: 146, spawnsDeferred: 39, debtCleared: 19, enemiesCut: 66` — cap, debt
  and cut all exercised in the shipped pipeline; manifest fingerprints
  `['1~-t9q0mj','2~-dr2oqs','3~-7xn72k']` stable across runs.

## Deviation (documented, not a shortcut)

Slice 2's `tests/headless/floor4-arena-completion.test.ts` asserted an **idle-player**
victory over an empty arena. With real waves that is no longer a true statement, and an
honest five-act clear depends on slices 4–7. Rather than manufacture a victory
(invulnerability, empty manifests, a cherry-picked seed — rules #11/#12), it is replaced
by `tests/headless/floor4-arena-waves.test.ts`, a bounded act-1 test gating what slice 3
owns. The end-to-end clear returns with slice 7's win-rate gate. Recorded in the spec.

## Verification

- `npm run typecheck` ✅
- `npx vitest run tests/unit/floor4-*.test.ts` ✅
- `npx vitest run tests/headless/floor4-arena-waves.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## What's Next / Blockers

- Slice 4 owns Headliners: boss summons share the concurrency cap but are excluded from
  manifests, debt and the cut (FR3.7) — spawn them **without** the `ArenaWaveEnemy` tag.
- Slice 5 replaces the auto-advancing intermission with the real Green Room transaction;
  debt clearing on phase transitions already covers that boundary.
- Slice 7 owns balance: `baseBudget`, `intraActRamp`, `concurrencyCap` and `debtCap` are
  provisional first-pass values living entirely in the manifest. Retune from sweep
  evidence, never from individual seeds.

## Retrospective

### Lessons Learned

- A per-tick `switch` phase machine silently becomes wrong the moment scheduled events
  live inside a phase: any delta larger than one boundary drops the events in between.
  The chronological boundary loop plus a one-call-vs-fixed-steps equivalence test is the
  cheap way to keep large-delta tests honest.
- Killing an enemy and _removing_ an enemy are different economic events. Reaching for
  the existing death path would have quietly credited the player with kills for wave
  enemies the show simply cut.

### Mistakes Made

- The first pass counted "deferred" spawns as the debt-queue length before the wave was
  queued, which double-counted across waves; it now measures what a wave queued but could
  not place immediately.
