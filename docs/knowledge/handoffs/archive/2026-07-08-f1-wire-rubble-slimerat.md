# Handoff: Wire Floor-1 rubble prop + slime-rat mid-boss to existing generated art

**Date:** 2026-07-08
**Session:** f1-wire-rubble-slimerat (F1 asset burndown + F2 art)
**Apple estimate:** 🍎🍎🍎🍎 (program) | **This slice:** 🍎🍎 (est) → 🍎🍎 (actual) | **Verdict:** exact

## Systems touched

enemies, boss-rooms

## Summary

Graphics/Content slice of the producer-orchestrated art program (orchestrator session
`d467a72d-b51e-43a9-b48c-1e38a442c986`). **Major scope reframe from the prior segment:**
every remaining Floor-1 REQUIRED sprite is already GENERATED + APPROVED + PNG-committed on
`main` — so the remaining F1 work is **pure wiring**, ZERO generation, ZERO manifest/catalog
touch. This slice wired two of the three remaining gaps to their existing approved art:

- **w1 — rubble prop:** `decorationDefs.ts` `rubble.spriteId` was the placeholder `'deco-rubble'`
  (not in the manifest ⇒ rendered a colored rectangle). Changed to the approved bare manifest key
  **`prop-rubble-pile-var-1`**, mirroring the working props (torch/junk-pile/wall-sconce). The
  PhaserBridge prop path renders a sprite iff `scene.textures.exists(spriteId)`, so it now resolves.
- **w3 — slime-rat mid-boss:** the Floor-1 spell-quest-room mid-boss (bossBattles key `'slime-rat'`)
  rendered the generic `enemy_boss` Kenney placeholder. Wired it to its approved dedicated art
  **`slime-rat-boss-var-1`** via the SAME mechanism as the `staircase` rat-slime boss (#476).

## What changed (4 code edits + 2 test updates)

| File                                          | Change                                                                                                                                                             |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/shared/decorationDefs.ts`                | rubble `spriteId` `'deco-rubble'` → `'prop-rubble-pile-var-1'`                                                                                                     |
| `src/shared/data/entity-sprite-mappings.json` | + `enemy_boss_slimerat` renderKind (generated block: briefId `slime-rat-boss`, pinnedTextureKey `slime-rat-boss-var-1`, scale 0.6) — mirrors `enemy_boss_ratslime` |
| `src/engine/phaser-bridge/sprite-kind.ts`     | + `enemy_boss_slimerat: 'slime-rat-boss'` to `GENERATED_BRIEF_BY_TYPE`                                                                                             |
| `src/engine/PhaserBridge.ts`                  | boss visualType switch: + `bossKey === 'slime-rat' ? 'enemy_boss_slimerat' : 'enemy_boss'` branch (L496)                                                           |
| `tests/unit/phaser-bridge.test.ts`            | boss test (L982): mid-boss now asserts `slime-rat-boss-var-1` (was `kenney-tiny-dungeon`); prop test (L270): + rubble renders `prop-rubble-pile-var-1` as a sprite |

## Observe before done (deterministic, real render path — NOT a lab)

`tests/unit/phaser-bridge.test.ts` drives the **real `createPhaserBridge(scene).sync(world)`** —
the exact render function `MainGameScene` calls every frame — over the real `decorationDefs`,
`entity-sprite-mappings.json`, and `sprite-kind` maps. It is NOT a `src/labs/**` force-call.

- **Before:** slime-rat mid-boss (bossKey `'slime-rat'`) → `'kenney-tiny-dungeon'` (generic placeholder);
  rubble prop → placeholder rectangle.
- **After:** mid-boss → `'slime-rat-boss-var-1'`; rubble → `'prop-rubble-pile-var-1'` sprite.
- 36/36 phaser-bridge tests pass; full `verify:fast` green (116 files / 1261 unit tests).

**Spawn→render chain is existing, traced code** (the branch is reached by the real game): the
mid-boss is spawned by `spawnFloor1SlimeRatBoss` (floorScenario.ts:1878), which sets
`bossBattles.get('slime-rat').bossEid`; the PhaserBridge render loop (L484-491) matches
`battle.bossEid === eid` → `bossKey='slime-rat'` → my new branch. Render observation is
render-layer-only (headless has no textures), so the real render function under a mock scene is
the deterministic artifact — the same way the sibling `staircase` boss (#476) was validated. No
new `*System` was added, so the orphaned-system wiring guard (ADR 0039) is N/A; `PhaserBridge.sync`
is already a live pipeline site.

### Key gotcha ruled out (why w3 is correct)

`generatedBriefIdForEnemy` checks `GENERATED_BRIEF_BY_APPEARANCE_KEY` **before** the type map, so
an appearanceKey collision could have overridden the wiring. Confirmed safe:
`spawnFloor1SlimeRatBoss` **never calls `setEnemyAppearanceKey`**, so the mid-boss has NO
appearanceKey → resolution falls cleanly through to `GENERATED_BRIEF_BY_TYPE['enemy_boss_slimerat']`
= `'slime-rat-boss'`. (The `staircase` boss sets appearanceKey `'rat-slime'` and resolves via the
appearance map; the two paths do not interfere — `'slime-rat'` ≠ `'rat-slime'`.)

## Review harness / ledger

- **2🍎 → zero required review stages** (AGENTS.md rule #14; the SKILL matrix showing 2🍎→plan-review
  is STALE — the floor was raised 2🍎→3🍎 on 2026-07-07, ADR 0036). Verified empirically:
  `review:ledger -- init --apples 2` scaffolds "required stages: (none)"; `validate` → exit 0.
- Ledger: `docs/knowledge/review-ledgers/2026-07-08-f1-wire-rubble-slimerat.review-ledger.json`.
- `gameplay_safe=false` from `npm run scope` is a conservative false-positive (union includes 54
  untracked residue files; `src/shared`/`src/engine` aren't auto-safe). The diff is genuinely
  gameplay-neutral — only render-layer fields changed (a `spriteId` string + render texture maps +
  a render-only visualType branch); nothing in `src/core`/`src/game/ai`/balance. The ~306s headless
  Floor-1 gate is deferred to its required CI job (which runs on non-`gameplay_safe` PRs).

## Remaining F1 burndown (this program)

- **w2 — tiles (~🍎🍎🍎, the one genuinely meaty piece):** the 5 approved F1 tile keys
  (`tile-stone-floor-v1-var-2`, `tile-stone-wall-v1-var-5`, `tile-door-v1-var-0`,
  `tile-boss-staircase-floor-v2-var-10`, `tile-safe-room-floor-v1-var-0`) exist + committed, but
  `terrain-renderer.ts`/`buildTerrainLayer` still only stamps Kenney spritesheet frames. Needs the
  single-texture tile-stamp ENGINE change (extend `TileVisualDef`) + wire the 5 keys + lab +
  headless probe. Full review harness (plan review + code-review loop + ledger). Best as a
  dedicated session — shares the tile-stamp path with F2 cave tiles.
- **w4 — items:** COMPLETED by PR #909 (asset-name normalization `resolveItemSprite`); just observe
  in the real InventoryUI after #909 merges. No generation.

## F2 art (deferred behind F1 gate)

- **42/44 enemy sprites generated + approved, 0 wired** (inert). Wiring template = **PR #907**
  (def-aware NPC resolver): `GENERATED_KEY_BY_NPC_DEF` + pure `pickGeneratedNpcTextureKey` +
  `resolveNpcTexture`. ⚠️ **Pin EXACT approved key per identity — never roll-to-index** (variants
  are non-uniform; approval culls to one surviving variant). The full 42-pin map + 2 gaps
  (`raccoon-boss`, `imp-boss` need generation) is built + verified in `files/f2-enemy-pin-map.json`.
- **Cave tiles** (`cave-floor-var-8`, `cave-wall-var-5`) generated + committed — wire into the
  `cave_system` biome via the shared tile-stamp path (w2).

## Next steps

1. Open the w1+w3 PR, arm `gh pr merge --auto --squash`, verify MERGED + clear any Copilot review
   threads (reply `✅ Addressed`, self-resolve `copilot-pull-request-reviewer` threads via GraphQL).
2. Report the merge to the orchestrator (`d467a72d`); with w1/w3 merged + w4 via #909, F1 wiring
   is down to **w2 tiles only**.
3. Start w2 tiles (dedicated session or here) — the single meaty remaining F1 piece; shares the
   tile-stamp engine change with F2 cave tiles.
