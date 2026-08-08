# Session Handoff: Wire welcome-room NPCs to distinct generated sprites

## Date

2026-07-08

## Persona

Producer → Sprite/Rendering (Engine)

## Systems touched

sprite-pipeline, devtools

## Apples

2🍎 estimated, 2🍎 actual — 🎯 exact. Essential production change is a pinned pure
helper + a 2-point NPC render-branch wiring that mirrors the existing enemy
generated-texture path; no new module/system, no ADR, no algorithm. The dev-only
lab enhancements + the test suite (a 2🍎 trait) and one trivial unrelated
test-timeout fix pad the file count, but blast radius is low (render-only,
placeholder-free fallback preserved).

## What Was Done

Follow-up to the merged welcome-room set piece (PRs #853/#905) now that the 3 NPC
sprites landed on `main` (PR #906, `d7337301`). Wired each Floor-1 welcome-room NPC
to render its OWN distinct generated sprite instead of all three sharing the Kenney
villager placeholder:

- `tutorial-goon` → `npc-welcome-goon-var-0`
- `shopkeeper` → `npc-sweaty-merchant-var-0`
- `spell-quest-giver` → `npc-spell-broker-var-1` (var-**1**, not var-0)

Implementation:

1. **Pure resolver** in `src/engine/phaser-bridge/sprite-kind.ts`: added
   `GENERATED_KEY_BY_NPC_DEF` (the 3 pinned mappings) + `pickGeneratedNpcTextureKey(defId)`,
   mirroring the enemy `pickGeneratedEnemyTextureKey` helper so it is unit-testable
   without a Phaser scene. Keys are **pinned** (not roll/index-computed) because the
   broker is var-1 while the others are var-0 — an index roll would mis-pick.
2. **Def-aware render wiring** in `src/engine/PhaserBridge.ts`: added
   `GENERATED_NPC_SPRITE_SCALE = 0.4` + `resolveNpcTexture(scene, defId)`, which
   returns the generated key when `pickGeneratedNpcTextureKey(defId)` is non-null AND
   `scene.textures.exists(key)`, else falls back to the villager via
   `resolveTexture(scene, 'npc')`. Wired at NPC visual creation and added an
   `entityType === 'npc'` late-load reconcile branch (mirrors the enemy reconcile) for
   defensively swapping in a generated texture that preloads after the sprite is made.
3. **Set-piece lab tooltip** (`src/labs/set-piece-lab/index.ts`): NPC tooltips now
   resolve the pinned key live and show a `✔ real art / ▢ villager fallback` badge +
   the generated key, instead of the old hardcoded `Kenney character · frame #10` line.
4. **Observation harness** (`src/labs/main-scene-probe-lab/index.ts`): added an
   additive `getNpcRenderInfo()` probe (existing e2e don't call it) that ties each live
   NPC's `defId` → the texture key of its nearest rendered sprite by position.
5. **Tests**: unit block for `pickGeneratedNpcTextureKey` / `GENERATED_KEY_BY_NPC_DEF`
   in `tests/unit/phaser-bridge-sprite-kind.test.ts`; manifest guard in
   `tests/integration/generated-manifest-engine.test.ts` asserting the 3 keys resolve
   to non-placeholder manifest entries + cross-checking the map (a rename on either
   side now fails loudly).

**Observed in the REAL `MainGameScene`** (rule #10/#15) — not lab-only. The
`main-scene-probe-lab` boots the shipped Floor-1 game via
`createFloor1GameConfig`/`createFloor1MainSceneOptions` (fixed seed 4242), the exact
production bootstrap. Captured via a standalone Playwright probe of `getNpcRenderInfo()`:

- **BEFORE** (render path stashed): all 3 NPCs → `kenney-tiny-dungeon` (the shared
  villager). `distinctRenderedNpcTextureCount: 1`, `allThreeDistinctGenerated: false`.
- **AFTER**: `tutorial-goon`→`npc-welcome-goon-var-0`, `spell-quest-giver`→
  `npc-spell-broker-var-1`, `shopkeeper`→`npc-sweaty-merchant-var-0`, each with
  `distancePx: 0` (exact NPC-feet position match — no sprite ambiguity).
  `distinctRenderedNpcTextureCount: 3`, `allThreeDistinctGenerated: true`,
  `consoleErrors: []`. This satisfies the single hard gate.

Evidence artifacts (session `files/`, not committed): `welcome-npc-before.png`,
`welcome-npc-after.png`, `welcome-npc-after.json`, `observe-npc.mjs`.

## Key Decisions Made

- **`defId`, not `textureId`, is the NPC differentiator.** NPCs do **not** resolve
  their texture via `textureId` (it is vestigial for NPC rendering — all 3 share
  `textureId: 10`). `resolveRenderKind` returns the broad kind `'npc'` for every NPC,
  so `resolveTexture` maps them all to the same villager. Identity reaches the renderer
  only via `world.npcs.get(eid)?.defId`. This **corrects the parent handoff**
  (`2026-07-08-welcome-room-art-wiring-lab.md`), which anticipated a "textureId →
  generated key swap"; that mechanism does not exist for NPCs.
- **Pinned keys, not a variant roll.** The broker is var-1 while the others are var-0,
  so any index-computed variant would mis-pick. The map hard-codes exact keys
  (project rule #12 — the broker MUST be var-1).
- **Placeholder-free fallback preserved.** If a generated texture is ever missing,
  `resolveNpcTexture` falls back to the current villager rather than a placeholder box,
  matching the requirement.
- **Scale 0.4** matches the enemy generated-art convention (64px source art → ~26px
  on-screen).

## What's Next / Blockers

- **No blockers.** Hard gate met in the real game; unit + manifest guards lock the
  mapping. PR ready.
- **Follow-up (non-blocking):** the `describeAsset`/tooltip resolver in the set-piece
  lab still mirrors engine resolution and could drift — extracting a shared structured
  resolver consumed by both the engine and the lab remains a good future refactor
  (carried over from the parent handoff).
- If any of the 3 sprites reads wrong in-engine, coordinate with the F1 asset burndown
  session (`cdb2b3a5-1fbd-4c33-afca-5232912acd7f`) for a regen; keys are confirmed live
  on `main`.

## Retrospective

### Lessons Learned

- **NPC texture selection is kind-broad by default.** Unlike enemies (which already
  have `pickGeneratedEnemyTextureKey` + a `generated` renderKind block), NPCs had NO
  per-def generated path — every NPC collapses to kind `'npc'` → one villager. Adding a
  distinct NPC sprite is therefore a _new_ def-aware branch in the PhaserBridge render
  loop, not a data swap. Don't trust `textureId` for NPC art.
- **`main-scene-probe-lab` is the honest real-artifact for NPC render checks.** It boots
  the shipped `MainGameScene` via the production Floor-1 bootstrap, so a probe there is
  NOT lab-only validation (rule #15). Its `getNpcRenderInfo()` matching each NPC's
  `defId` to the nearest sprite's texture key at `distancePx: 0` gives an unambiguous,
  deterministic BEFORE/AFTER.
- **`git stash push -- <single file>` is the clean BEFORE toggle.** Stashing only
  `PhaserBridge.ts` (not `sprite-kind.ts`) reverted the render path while keeping the
  pure helper's exports intact, so the other labs that import it still compiled and the
  probe method stayed available for the BEFORE capture. `stash pop` restored it.
- **Browser MCP is single-owner.** Both Playwright and chrome-devtools MCP reported
  "Browser is already in use" from another session. Workaround: a standalone Playwright
  script run via `node` — but it MUST live inside the repo tree (bare `playwright`
  import resolves by walking up for `node_modules`; the session `files/` dir has none
  up-tree). Kept a temp copy at repo root and deleted it before commit.

### Mistakes Made

- **Ran full `verify` under self-inflicted load and hit a flaky timeout.** The first two
  `npm run verify` runs failed on an UNRELATED test —
  `tests/unit/floor2-scenario-initialization.test.ts` "does not let settlement
  shop-count rolls perturb Floor 2 map generation" — timing out at the 30s unit default.
  Early signal: the failure was a _timeout_, not an assertion, and `import` time was
  591–1190s (massive contention from my still-running lab server + browser). The test
  passes in isolation (7/7, ~24.6s for the file) because it runs Floor 2 map generation
  **twice**. Per rule #8 I fixed it rather than dismissing it as pre-existing: gave that
  one test a 120s per-test timeout (matching the heavier vitest projects), with a
  rationale comment. The `toEqual` determinism assertion is unchanged — this only
  accounts for real wall-clock cost under parallel load (rule #12: didn't weaken the
  gate). Lesson: stop lab servers/browsers before running full `verify`, and treat a
  bare timeout on an inherently-heavy determinism test as a load artifact, not a
  correctness failure.

### Opportunities for Future Improvement

- **Generalize NPC generated-art wiring like enemies.** A `generated` block on the NPC
  renderKind + a def→brief convention would let `generate-wiring` auto-pin NPC sprites
  when new art lands, instead of a hand-maintained `GENERATED_KEY_BY_NPC_DEF` map.
- **Promote the NPC render check into a deterministic e2e.** `getNpcRenderInfo()` +
  `allThreeDistinctGenerated` is one assertion away from a headless/e2e guard that would
  catch a future regression to the shared-villager state without a manual probe.
- **Consider raising the unit `testTimeout` for the map-gen determinism suite** (or
  splitting the double-generation test) so it never brushes the timeout under CI load —
  the per-test bump here is a targeted patch, not a systemic fix.
