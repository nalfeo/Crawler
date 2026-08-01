# Session Handoff: crabfolk-claw-gunner brief authored, generation pending CI

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 estimated (art-only, brief authoring phase — generation pending CI pipeline)

## What Was Done

Authored `briefs/enemies/crabfolk-claw-gunner.yaml` for issue nalfeo/Crawler#2561.

The `crabfolk-claw-gunner` enemy (`Tidewrack Claw Gunner`, `aiType: ranged`, Floor 2)
already exists in `src/shared/data/enemies.floor2.json`. It currently falls back to the
`crabfolk-armored` sprite in `src/shared/generated-assets.ts` because no dedicated brief
or approved sprite existed.

**Brief design decisions:**

- `mobRole: normal`, `floor: 2` — matches enemy data exactly.
- `sensors.enemy.facing: front` with `toleranceDeg: 20` — issue specifies "front-facing";
  matches `imp-chain-brawler` and `llama-curb-stomper` conventions for melee/ranged soldiers.
- `judge.enabled: true, maxVariants: 4` — VLM scoring active; consistent with other Floor 2
  enemy briefs (`faerie-spark-caster`, `crabfolk-boss`).
- 4 named variation seeds with `minVariations: 4` — each seed emphasises a distinct
  sub-read: cannon-claw forward, scuttling stance, heavy rivet pattern, anchor-chain detail.
- Palette: natural chitin in blue-gray / deep slate (matches issue spec and crabfolk-boss
  chitin palette); gunmetal iron cannon sleeve with verdigris patina; Tidewrack Mob accent
  details (gold earring/chain, saltwater-taffy foil scrap).
- No `sizeVariant` key — enemy is default-size (`spriteWidth/Height: 2.2`) per game data.

**Generation attempt:** Not attempted — Azure credentials are intentionally unavailable to
the coding-agent runner. The CI `asset-request.yml` drain pipeline will pick up this brief
on its next run.

## What's Next / Blockers

The brief is ready. The sprite needs to be generated, judged, approved, and checked in.

### Next session checklist (requires Azure credentials or CI pipeline):

1. **Wait for CI generation**: check issue #2561 for a pipeline comment:
   `✅ Asset-request pipeline complete. - brief: crabfolk-claw-gunner - run: <runId>`
   If absent, the next `asset-request.yml` drain run will pick it up.

2. **Judge candidates** (invoke `sprite-judge` skill):
   - Does the cannon claw read as a barrel pointed outward?
   - Is the silhouette medium-weight (lighter than shell-capo)?
   - Is the natural claw visible on the opposite side?
   - Blue-gray chitin, gunmetal cannon sleeve, verdigris patina?
   - No background, no text, hard pixel edges, transparent bg?
   Never loosen a failing sensor to pass.

3. **Approve winner**: `npm run sprites:approve -- generated/runs/crabfolk-claw-gunner/<runId> --variant <N>`
   Winner needs `combinedPassed: true` AND VLM judge score ≥3.

4. **Check in**: `npm run sprites:checkin`

5. **Asset PR**: `asset-pr` skill → `npm run sprites:asset-pr`
   PR should close nalfeo/Crawler#2561.

6. **Update `src/shared/generated-assets.ts`**: once the sprite is approved and checked in,
   the `crabfolk-claw-gunner` entry should map to the new sprite key instead of `crabfolk-armored`.

## Retrospective

Straightforward brief authoring. The enemy data was already complete; only the brief and
sprite were missing. No code changes were required.
