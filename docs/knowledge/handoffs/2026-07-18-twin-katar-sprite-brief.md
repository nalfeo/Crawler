# Session Handoff: twin-katar Sprite Brief

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, floor-2-equipment

## Apples

1🍎 — pure art task: brief authoring. No engine code touched.
Generation blocked by CI environment (Azure OpenAI credentials not available); brief is
the canonical source for the next generation run via `asset-request` GitHub Actions
workflow.

## What Was Done

Handled issue #1456 for the `twin-katar` weapon sprite icon. The brief has been authored
and committed to the `copilot/add-twin-katar-icon-again` branch.

### Brief authored: `briefs/weapons/twin-katar.yaml`

- **Runtime key**: `equipment/weapon/twin-katar`
- **Type**: weapon (inherits 64×64, vertical orientation, kenney-roguelike palette,
  4×4 sheet, VLM judge from `data/sprite-types/weapon.json`)
- **Design**: matched pair of H-frame katars (push daggers), both blades pointing upward
  symmetrically. V-silhouette at the top, central grip at the bottom. Floor 2
  dungeon-worn steel: cold blue-grey blades, dark iron H-frame hardware, worn leather
  wrap. No glow, no enchantment.
- **Composition**: blades as side-by-side V (or crossed X per variation) — single
  composed icon, not two separate weapons
- **Orientation**: vertical (weapon default) — grip at the bottom, blades at the top
- **Variations**: 2 seed entries (X-cross variant, ornate finger-ring guards) +
  `minVariations: 8` for LLM expansion

### Why generation is blocked

The Copilot Coding Agent runs in a CI/cloud environment (`CI=true`) where the
`setup-azure-env.ps1` script no-ops by design (no `az login`). The sprite generation
CLI (`npm run sprites:run`) requires `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY`
which are not injected into the agent environment — they are available only to the
`asset-request.yml` GitHub Actions workflow via repository secrets.

Per the Azure-required sidecar policy (AGENTS.md §"Azure-required sidecar policy"),
the agent must not silently fall back to `local/noop` backends.

### Established precedent

This is the same situation as the `cactusfolk-boss` brief update (handoff
`2026-07-17-cactusfolk-boss-sprite-brief.md`): author the brief in CI, let
generation happen via the `asset-request` workflow.

## Next Steps

1. **Generate sprites**: trigger `asset-request.yml` via `workflow_dispatch` on
   the `twin-katar` brief, or open an `asset-request`-labeled issue from a trusted
   account.
2. **Judge & approve**: use `npm run sprites:approve -- <runDir> --variant <N>` on
   the best-scoring variant (combinedPassed=true, judgeScore≥3).
3. **Check-in**: `npm run sprites:checkin` → `asset-checkin` issue
4. **Batch PR**: `npm run sprites:asset-pr` folds the check-in issue into an art-only PR
5. **Wire**: once the manifest has `briefId: twin-katar` entries, the sprite
   auto-resolves when the twin-katar equipment def is added to the game
   (item-sprites.ts uses `itemId → briefId` matching). No manual wiring needed.

## Observe Before Done

Not applicable for this brief-only delivery. Observation is required after the
sprite is generated and the equipment def is added:

- Confirm the sprite renders in `npm run lab` (equipment-lab) at game scale
- Confirm it reads as a dual-blade push-dagger silhouette at 64×64

## Key Decisions

1. **Vertical orientation (default)** — both blades point upward with the grip at
   the bottom. Matches the weapon type default; renderer can rotate around the anchor.
2. **V-silhouette** — the twin blades fan slightly outward at the top, giving a
   clear "dual-weapon" read at a glance.
3. **No side-profile override** — unlike `iron-sword` (diagonal) or `compact-disk`
   (diagonal), the twin-katar pair reads better in vertical composition.
4. **No game def stubs** — the brief is the only deliverable for this art ticket.
   `compact-disk` and `skull-mace` also have briefs but no `ITEM_CATALOG` entries;
   same pattern applies here. Game mechanics follow in a separate ticket.
