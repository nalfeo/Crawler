# Session Handoff: Remove floor-specific branches from generic systems

## Date

2026-08-30

## Persona

Systems Engineer

## Systems touched

enemies, quests, hud-ux

## Apples

2🍎 estimated, 2🍎 actual (on target — one schema flag, one contract member,
three converted call sites, all behavior-preserving).

## What Was Done

Three generic call sites stopped branching on floor identity (issue #3902):

1. `attackWaveSystem` gates on the new `FloorBehavior.trashAttackWaves` flag
   instead of `world.floorId !== 'floor1'`, and sizes its off-screen spawn ring
   from the running floor's manifest camera zoom instead of `floor1Config`.
   `src/game/attack-wave-system.ts` no longer imports `floor-config.js`.
2. `requiredShopPurchaseReserve` gates on
   `behavior.merchantCharmGatesEquipment !== null` plus an explicitly assigned
   `world.floorId`, instead of `world.floorId !== 'floor1'`.
3. `MainGameScene.openLoadoutModal` renders
   `ScenarioPresentationContract.starterLoadout` copy instead of the literal
   `'Floor 1 is paused until you confirm a starter weapon.'`.

ADR: `docs/knowledge/adr/2026-08-30-floor-config-driven-generic-systems.md`.

Observed in the real artifact (rule #9): `tests/e2e/main-game-scene-boot.test.ts`
boots the shipped Floor 1 bootstrap in `MainGameScene` and asserts the rendered
loadout-modal title, subtitle, body and option descriptions — before, that copy
came from a floor literal in the renderer; after, it comes from the scenario
contract and the rendered strings are identical. Green on both the `e2e` and
`e2e-game` projects.

## Key Decisions Made

- Reused the two existing config channels (`FloorBehavior`,
  `ScenarioPresentationContract`) rather than adding a third.
- The reserve requires a **non-empty `world.floorId`**. `getWorldFloorBehavior`
  falls back to `floor${world.floor}` and `world.floor` defaults to `1`, so
  without that requirement every `createTestWorld()` world would have inherited
  Floor 1's merchant-charm gate — caught by
  `tests/game/spell-broker-progression.test.ts` on the first attempt.
- Settlement-return routing was deliberately **left alone** (see below).

## What's Next / Blockers

No blockers. Remaining floor-identity branches, in rough value order:

1. **Settlement-return routing defaults are hardcoded three times and disagree**:
   `headless-runner.ts` auto-enables on `floor1`, `headless-runner-cli-lib.ts` on
   `floor2`, `src/labs/ai-runner-lab/settlement-return-policy.ts` on `floor1 ||
floor2`, and `headless-runner-cli.ts` has a fourth copy in its log line. A
   single `FloorBehavior` flag collapses all four, but the runner-vs-CLI split is
   _pinned by an existing test_ ("the RUNNER default stays off on Floor 2" in
   `tests/headless/settlement-return-routing.test.ts`) and sweeps call
   `runHeadless` directly — so unifying is an AI-behavior change that needs a
   Floor 2 win-rate sweep as evidence, not a mechanical refactor.
2. **`MainGameScene`'s `world.floorId === 'floor3'` loadout-surface branch** —
   needs a loadout _surface_ contract (intro/poach/starter), a bigger slice than
   the copy move done here.
3. **`achievementSystem`** still computes facts through `world.floor === 1` /
   `=== 2` branches; that one wants scenario-owned fact contributors.
4. `bt-ai-provider.ts` (`isFloor1Run`, the Floor 2 hunt recovery window) and the
   `map-gen-lab` / `runtime-preview` floor constraint switches.

A `npm run check:floor-branches` deterministic guard would be the right capstone
once (1)–(3) land, but it needs a designed allowlist for the files that are
legitimately floor-shaped (floor scenarios, manifests, registry).

## Retrospective

### Lessons Learned

- `getWorldFloorBehavior(world)` is **not** a drop-in replacement for a
  `world.floorId === 'floorN'` check: it falls back to the numeric `world.floor`,
  which defaults to `1`. Any conversion of a Floor 1 gate must decide explicitly
  whether synthetic worlds (`floorId === ''`) should inherit Floor 1 behavior.
- `tests/unit/floor-behavior.test.ts` asserts each manifest's behavior block with
  `toEqual`, so every new flag requires four expectation updates there.
- Playwright browsers are still not preinstalled in the sandbox;
  `npx playwright install chromium` is required before any e2e run.

### Mistakes Made

- The first version of the reserve conversion dropped the `floorId` requirement
  and silently turned the Floor 1 gold reserve on for every synthetic test world,
  breaking two spell-broker intent tests. The fix was to require an explicit
  floor assignment, which is now stated in the function's own doc comment.

### Opportunities for Future Improvement

- `FloorBehavior` is up to 12 flat flags. A future slice could group them
  (`safeRoom`, `economy`, `spawning`) before it grows further.
