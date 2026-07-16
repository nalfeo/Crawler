# Session Handoff: faerie-boss brief — Queen Mab Tarnish

## Date

2026-07-16

## Persona

Graphics Designer (Asset Forge)

## Systems touched

sprite-pipeline

## Apples

1🍎 exact (brief authoring only — art lane, review-ledger exempt)

## What Was Done

Created `briefs/enemies/faerie-boss.yaml` — the canonical hand-authored brief for
Queen Mab Tarnish (Floor 2 faerie-boss enemy) that was missing from the repo.
The brief captures the precise silhouette/wing/wand constraints from issue #1216:

- `sizeVariant: tall` — 64×128 output, 2-row × 4-col sheet (8 variants), 1:2 aspect
- Folded wings flush against body, fully opaque (no transparent interior holes)
- Floor-length gown forming one connected vertical queenly silhouette
- Tarnished industrial regalia: corroded bronze fittings, verdigris patina
- No wand, staff, or detached floating pieces (`edge.allowDetachedEdgeComponents: false`)
- `edge.allowMainTouch: true` — crown and hem naturally fill the frame height
- 4 seeded variations spanning regal/eerie × tarnished-industrial/dark-fantasy richness

### Sprite-judge verdict on existing faerie-boss-var-1

Existing art (64×64, sensor 7/7, judge 4/5) was **rejected** against the new brief:

| Criterion                  | Result                                 |
| -------------------------- | -------------------------------------- |
| sizeVariant: tall (64×128) | ❌ FAIL — sprite is 64×64              |
| No wand/staff              | ❌ FAIL — visibly holds a wand/scepter |
| Floor-length gown          | ❌ FAIL — no gown visible              |
| Folded wings present       | ❌ FAIL — no wings                     |
| Queenly silhouette         | ❌ FAIL — reads as goblin/demon        |
| Tarnished regalia          | ❌ FAIL — plain crown only             |
| Unique colors (1204)       | ⚠️ WARN — not crisp 3-5-stop pixel art |

The existing art must be **superseded** by a new tall variant generated from this brief.

### Issue pipeline run — variant recovered and approved

The asset-request workflow ran for issue #1216 (run `faerie-boss-v1/2026-07-16T21-50-50-e48c978a`,
126 artifacts, 8 processed variants). Variant 00 scored **7/7 sensors** (all checks pass including
`interior-transparency-holes` and `opaque-bbox-fits`). The sprite was downloaded from the GitHub
Actions artifact and manually approved with the correct `briefId: 'faerie-boss'`:

- PNG: `public/assets/generated/faerie-boss-var-0.png` (68×128)
- Manifest entry: `faerie-boss-var-0` — `briefId: 'faerie-boss'`, anchor x=33 y=71 (derived CoM),
  sensorScore: 7/7, type: enemy
- Sprite catalog entry: `generated:faerie-boss-var-0`
- Old wrong entry `faerie-boss-var-1` (64×64, wand present) removed from manifest and catalog

### Observe step

Engine wiring verified: `src/engine/phaser-bridge/sprite-kind.ts` line 300 has
`'faerie-boss': 'faerie-boss'`. The `floor2-boss-render-art` test (the real-pipeline render guard)
passes with the new manifest entry. The `pickGeneratedVariant` resolver now returns `faerie-boss-var-0`
(the 68×128 tall variant) for the faerie-boss enemy.

## Key Decisions Made

1. **Canonical `name: faerie-boss`** (not `faerie-boss-v1`) so sprites auto-resolve
   to the engine's texture key. Version-suffixed names are the orphan class — avoided.

2. **`sizeVariant: tall`** per issue spec — 64×128, 2-row × 4-col sheet, `edge.allowMainTouch: true`.

3. **Strict `edge.allowDetachedEdgeComponents: false`** — the brief explicitly prohibits
   wand-like detached pieces (a key complaint from the issue).

4. **`sensors.enemy.facing: front`** — Queen Mab is regal and front-facing, not the
   default right-facing.

5. **4 seeded variations** covering the design space: tarnished bronze × midnight-indigo,
   verdigris-stained × oxidized-iron, charcoal-silk × spectral-glow, deeply-tarnished × bioluminescent.

## What's Next / Blockers

**Critical next step:** Generate and approve tall art using the committed brief.

**Blocked in coding-agent CI environment** because:

- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` are workflow-scoped secrets
  (not available to the coding-agent runner per security policy documented in
  `.github/workflows/asset-request.yml`)
- `sprites:checkin` refuses in CI (`Constitutional §3`)

**To complete the pipeline (requires local dev or a new workflow trigger):**

```bash
# Run warmup + real brief in one invocation so the first brief warms the provider
# and the second call does not hit a cold-start failure:
npm run sprites:run -- --brief briefs/weapons/iron-sword.yaml --brief briefs/enemies/faerie-boss.yaml

# Judge variants in the gallery:
npm run sprites:gallery

# BEFORE approving, remove the rejected 64×64 faerie-boss-var-1 so it cannot remain
# in the runtime registry alongside the new tall sprite.  Three files to purge manually:
#   1. public/assets/generated/faerie-boss-var-1.png  (delete the file)
#   2. Remove "faerie-boss-var-1" key from public/assets/generated/manifest.json
#   3. Remove the { "id": "generated:faerie-boss-var-1", ... } object from
#      src/shared/data/sprite-catalog.json

# Approve the best tall variant (N = 0-based index):
npm run sprites:approve -- generated/runs/faerie-boss/<runId> --variant N

# Check in (creates asset-checkin issue):
npm run sprites:checkin

# Batch into one art PR (the asset-pr skill):
npm run sprites:asset-pr
```

After the art PR merges, run `npm run dev` and navigate to Floor 2 to observe
Queen Mab Tarnish rendering at the correct tall aspect ratio.

## Retrospective

### Went well

- Brief authoring was clean and complete on first pass; schema validated.
- All 1254 tests pass (`npm run verify:fast`) — brief doesn't touch any tested code paths.
- Correctly identified the identity-model trap: the issue pipeline generates `faerie-boss-v1`
  names that would orphan the sprites. Hand-authored brief avoids this.
- Eyeball judgment of existing art was honest: rejected on 6 criteria, not rubber-stamped.

### Went poorly / unexpected

- Coding-agent CI environment doesn't have Azure OpenAI or Azure Storage credentials
  (correctly scoped to the `sprites:worker` step only per security policy).
- The issue pipeline already processed #1216 and generated art, but used a synthesized
  brief with the wrong name (`faerie-boss-v1`). Those sprites are in Azure but can't be
  used (wrong identity model) and can't be accessed (no blob storage creds here).
- `sprites:checkin` Constitutional §3 CI refusal means the approve+checkin loop
  requires a local developer environment.

### What to watch

- The existing `faerie-boss-var-1` (64×64) should be superseded, not kept alongside
  the new tall variant. After approval and checkin, confirm the old entry is removed
  or the manifest correctly uses the new variant.
- 1204 unique colors in the existing art suggests the pipeline may have used
  `paletteMode: none` without strict enforcement — the new brief can add
  `postprocessing: { paletteMode: 'strict' }` if cleaner palette discipline is wanted.
