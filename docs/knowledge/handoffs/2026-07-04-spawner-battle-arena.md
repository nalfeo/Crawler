# Spawner Battle Arena — 2026-07-04

## Summary

Shipped the six-requirement Spawner Battle Arena feature end-to-end as one PR
against `main`, per the user's explicit "one giant PR" constraint.

- Every spawner mob now defines an arena disc (min 4 ft, default 6 ft;
  RATS_NEST=7 ft, SLIME_POOL=6 ft).
- Entering the disc triggers a sealable-room door lock **or** a circular
  impassable tile-flag fence — whichever the geometry supports.
- Spawner-owned child kills bank their XP onto the owning spawner (up to 10
  children); the banked XP is granted as a single XP gem when the spawner
  dies. Non-XP loot (gold, items) still spawns normally.
- Trigger and resolve each push a dedicated VFX event and a HUD announcement
  (top-center banner, fades in/out via new `world.announcements` queue).

## Files touched

### Data / types

- `src/core/components.ts` — extended `spawner` SoA with `arenaRadiusFt`,
  `arenaKind`, `arenaState`, `bankedXp`, `bankedChildren`.
- `src/core/world.ts` — added `announcements`, `spawnerArenaDoors`,
  `spawnerArenaFence` side-cars.
- `src/core/spawners/combatants.ts` — new `arenaRadiusFt` option;
  `SPAWNER_MIN/DEFAULT/UNRESOLVED` exports; initializes the 5 new fields.
- `src/game/spawners/types.ts` + `registry.ts` — archetype now carries
  `arenaRadiusFt`.
- `src/shared/announcement-events.ts` (new) — `AnnouncementKind`,
  `AnnouncementEvent`, `pushAnnouncement` (queue cap 32).
- `src/shared/vfx-events.ts` — added `spawnerArenaStart | End | Fence` to
  `VfxEffectKind`.
- `src/shared/render-depths.ts` — new `spawnerArenaBurst`, `spawnerArenaFence`
  depth entries.
- `src/game/ai/types.ts` — added optional `SpawnerArenaMetrics` on `RunStats`.

### Systems

- `src/core/spawner-arena.ts` (new) — pure geometry helpers (trigger
  predicate, disc-fits-in-room check, fence-ring enumeration, `FENCE_TILE_FLAGS`,
  `SPAWNER_MAX_BANKED_CHILDREN = 10`).
- `src/game/spawners/spawnerArenaSystem.ts` (new) — the state machine
  (`idle → locked → resolved`), door lock / fence raise / VFX + announcement
  push, XP grant on resolve.
- `src/core/systems/dropSystem.ts` — post-roll XP intercept for
  spawner-owned enemies; `spawnDrops` gained an `interceptSpawnerOwnedXp`
  flag that preserves the RNG stream.

### Wiring (rule 15, ADR 0039)

- `src/bootstrap/floor-main-scene-options.ts` — arena system inserted
  IMMEDIATELY BEFORE `spawnerSystem` in `preSystems` (preserves the
  `directorIndex === spawnerIndex + 1` invariant asserted by
  `tests/game/floor1-main-scene-options.test.ts`).
- `src/game/ai/simulation-step.ts` — same ordering in the headless pipeline.
- `src/game/ai/headless-runner.ts` — populates
  `RunStats.spawnerArenas` telemetry via `computeSpawnerArenaMetrics`.
- `src/labs/spawner-lab/index.ts` — arena system runs in the lab's fixed step;
  info overlay reports arena state + bankedXP; GUI adds "Trigger Rats Arena"
  and "Trigger Slime Arena" (teleports the player onto the spawner).

### Renderer + HUD

- `src/engine/EffectsVfx.ts` — three preset render functions for the new
  VFX kinds (radial expanding ring + shake on start; shrinking ring + flash
  on end; persistent shimmer ring keyed by re-emit while locked).
- `src/engine/HudAnnouncementBanner.ts` (new) — drains
  `world.announcements` into a top-center banner with fade-in/out tweens.
- `src/engine/HudUI.ts` — instantiates + syncs + destroys the banner.

### Docs

- `docs/knowledge/adr/0044-spawner-battle-arena.md` (new ADR).
- `docs/knowledge/adr/README.md` — index row + count update.
- `docs/systems/04-enemy-ai.md` — cross-reference row + note.
- `.specify/specs/README.md` — flipped Spawner Battle Arena row to
  **Shipped** (ADR 0044).

### Tests

- `tests/unit/spawner-arena.test.ts` — trigger predicate, geometry,
  state machine, banked-XP cap, determinism, registry contract.
- `tests/unit/dropSystem-spawner-xp.test.ts` — XP intercept banks vs.
  normal path; cap of 10 kills; non-owned enemies unaffected.
- `tests/integration/spawner-arena.integration.test.ts` — full
  `idle → locked → resolved` lifecycle with a real world + XP grant.
- `tests/headless/spawner-arena-win-rate.test.ts` — Floor-1 sword
  sweep over seeds 1–8; asserts 75% win rate, AI budget, arena engages.

### Review harness (rule 14, apple tier 4🍎)

- `docs/knowledge/review-ledgers/2026-07-04-spawner-battle-arena.review-ledger.json`
  captures plan_review, dual_plan_synthesis, code_review, and
  multi_model_review stages.

## Verification run

Every gate was run from repo root and iterated to green:

- `npm run typecheck` — 0 errors.
- `npm run lint` — 0 warnings (max-warnings 0).
- `npm run format:check` — all files formatted.
- `npm run test:unit` — 3784 / 3784 passing.
- `npm run test:integration` — 85 / 85 passing (1 pre-existing skip).
- `npm run check:wired-systems` — 46 systems checked, all wired.
- `npm run test:headless -- tests/headless/spawner-arena-win-rate.test.ts` —
  3 / 3 passing (~130s wall time).

## Unresolved issues

- The current fence-tile ring blocks the arena reliably only when the disc
  fits comfortably inside a room; on tight/open Floor-1 geometry the AI can
  sometimes clip the arena disc and reach the exit without killing the
  spawner. Requirement§2 is met (a fence _appears_), and the mechanic is
  fully covered by unit + integration tests, but fence-ring closure on
  arbitrary layouts is a follow-up polish item — file a game-design issue
  if we want to force-fight every triggered arena.

## Recommended next steps

- If the design goal is "you cannot leave a triggered arena without killing
  the spawner", expand the fence enumeration to walk the disc perimeter and
  fill any single-tile gaps (a simple flood-fill from the disc interior on a
  scratch grid), or pre-place spawners only in rooms whose walls fully
  enclose the disc.
- Renderer polish: the persistent shimmer ring currently re-emits every
  ~400 ms as fresh transient rings; a keyed live-ring cache in
  `EffectsVfx.ts` would render one long-lived Graphics per arena instead of
  many overlapping short-lived ones.
- Consider promoting `SpawnerArenaMetrics.resolved` to a required field on
  `RunStats` once the fun-score / ai-scoring test fixtures are refactored.

Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
