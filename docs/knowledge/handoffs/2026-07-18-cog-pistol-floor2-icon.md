---
date: 2026-07-18
persona: Graphics Designer
systems_touched:
  - sprite-pipeline
  - sprite-workflow
apples: 1
---

# Session Handoff: cog-pistol Floor 2 Equipment Icon

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

1🍎 — pure art task: brief authoring + pipeline prep. No gameplay code changes.

## What Was Done

Handled asset-request issue #1335 for the `cog-pistol` Floor 2 equipment icon.

### 1. Kickoff verdict

**Recommended.** Clear, bounded art request with no gameplay impact. Brief scope
is unambiguous: a steampunk/industrial pistol weapon icon for Floor 2. 1🍎.

### 2. Brief authored

Created `briefs/weapons/cog-pistol.yaml`:

- **Type**: `weapon` — inherits 64×64 size, `kenney-roguelike` palette, vertical
  orientation sensor, 4×4 sheet, VLM judge enabled from `data/sprite-types/weapon.json`.
- **Subject**: steampunk/industrial single-action revolver with visible cog/gear
  mechanisms. Barrel points up (grip at bottom), worn steel + leather grip +
  brass/copper cogs with patina. No glow, no magic, silhouette reads "pistol
  with gears" at a glance.
- **Variations seed**: elongated spiral barrel + double-hammer variant. `minVariations: 8`
  to encourage design diversity across the 4×4 sheet.
- **Anchor**: inherited default (32, 56) — grip bottom of a vertical weapon. Correct
  for a pistol held upright.

Brief schema validated: `npm run sprites:run -- --brief briefs/weapons/cog-pistol.yaml`
parsed cleanly (failure was `AZURE_OPENAI_ENDPOINT` missing — expected in CI, not
a schema error).

### 3. Sprite generation (blocked — environment constraint)

The Azure sidecar cannot run in this GitHub Actions CI environment:

- `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` not available in this session
- `sprites:checkin` refused (`process.env.CI` is set)
- `sprites:asset-pr` refused for same reason

**Next action**: The `asset-request.yml` GitHub Actions workflow should be triggered
for issue #1335 (either manually via `workflow_dispatch` or by re-labeling the issue
with `asset-request`). The workflow will:

1. Run `sprites:ingest-once` to enqueue issue #1335 into the Azure queue
2. Run `sprites:worker` to generate, judge, and approve the sprite using the brief
3. Create an `asset-checkin` issue + `assets/<slug>` branch
4. The `asset-pr` skill batches it into a PR closing #1335

### 4. Issue comment (blocked — environment constraint)

GitHub API (GraphQL) is blocked by DNS monitoring proxy in this CI session.
REST API calls to `localhost:26831` (GitHub proxy) return 422 for POST requests.
The plan is documented here in the handoff instead.

### 5. Wiring

The brief name is `cog-pistol`. Once the sprite is approved and in the manifest:

- Manifest entry key: `cog-pistol-var-N`
- Auto-resolution: `resolveItemSprite('cog-pistol', registry)` will find it
  via `matchConcept(briefId, 'cog-pistol')` in `item-sprites.ts`
- No code changes required for icon resolution — the runtime key
  `equipment/weapon/cog-pistol` maps directly to the brief ID by convention

### 6. verify:fast

`npm run verify:fast` passed after brief creation:

- 87 test files, 1260 tests — all pass
- No regressions

## Key Decisions Made

1. **Vertical orientation** (inherited default) — a pistol held upright grip-down
   is the correct weapon canon for the engine renderer. No orientation override needed.

2. **Default anchor (32, 56)** — grip-bottom-center. Correct for vertical weapon.
   Derived-anchor mode (`anchor.derive: true`) is also inherited, so the pipeline
   will refine the anchor from the actual silhouette.

3. **minVariations: 8** — the 4×4 sheet has 16 cells; requiring 8 variations
   ensures the Azure model produces a diverse range of steampunk pistol designs
   rather than 16 near-identical copies.

4. **No sizeVariant override** — `cog-pistol` is a standard 1-handed weapon.
   The 64×64 default is appropriate.

5. **`judge.enabled: true` inherited** — all weapons get VLM judging for free.
   This rejects variants with low style_match/brief_match/readability scores.

## What's Next / Blockers

1. **Trigger the `asset-request.yml` workflow** for issue #1335:

   ```
   gh workflow run asset-request.yml --repo nalfeo/Crawler
   ```

   OR re-label the issue with `asset-request` to re-trigger the webhook.

2. **Review generated sheet** — inspect `generated/runs/cog-pistol/<runId>/` via
   the sprite-forge lab or the `sprite-judge` skill. Accept/reject/regenerate.

3. **Approve best variant**:

   ```
   npm run sprites:approve -- generated/runs/cog-pistol/<runId> --variant N
   ```

4. **Check in**:

   ```
   npm run sprites:checkin
   ```

5. **Batch into asset PR**:

   ```
   npm run sprites:asset-pr
   ```

   The asset PR will auto-close issue #1335 via `Closes #1335`.

6. **Observe before done** — after merge, `npm run dev` or headless probe to
   confirm `cog-pistol-var-N.png` renders correctly in the equipment UI.

## Before / After Observation

- **Before**: No brief, no sprite, no manifest entry for `cog-pistol`
- **After this session**: `briefs/weapons/cog-pistol.yaml` authored and committed;
  pipeline ready to generate once Azure workflow is triggered
- **After pipeline runs**: `public/assets/generated/cog-pistol-var-N.png` +
  manifest entry → auto-resolves in `resolveItemSprite`
