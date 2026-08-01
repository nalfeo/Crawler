# Handoff: raccoon-bottle-rocketeer sprite — Floor 2 ranged enemy

## Date

2026-08-01

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

1🍎 — brief YAML (art-only, ledger-exempt) + fixture entry + focused parser regression test.

## What Was Done

Handled issue #2567 (`feat(assets): raccoon-bottle-rocketeer enemy sprite`) using the
established asset-request brief pattern for Floor 2 enemy sprites:

1. **Brief authored** at `briefs/enemies/raccoon-bottle-rocketeer.yaml`:
   - Rich description anchored to the raccoon family palette (deep charcoal/near-black
     fur, natural gray-and-black face-mask, dark rust + tarnished brass for hardware).
   - Shoulder-mounted multi-tube bottle-rocket launcher (makeshift bazooka aesthetic),
     singed fur on the launching arm, goggles pushed up on the forehead.
   - Front-facing sensor override (`sensors.enemy.facing: front, toleranceDeg: 25`)
     matching the issue brief's explicit "front-facing" requirement.
   - Single saturated accent (electric orange / sulfur yellow rocket tips) to reinforce
     the explosive-specialist read without breaking the dark Floor 2 palette.
   - 4 variations + `judge.enabled: true` for auto-quality filtering in the CI pipeline.

2. **Issue fixture** added to `tests/fixtures/asset-request-issues.json` (verbatim body
   from GitHub issue #2567).

3. **Parser regression test** added to `tests/unit/sprites/asset-request.test.ts`:
   - Asserts `name=raccoon-bottle-rocketeer`, `type=enemy`, `floor=2`,
     `sizeVariant=default`, and fingerprint
     `b2bacbebc797520afa9707c2c2cf541123e8765c950979a9c7ec6c8b413622b4`.

4. **GitHub Actions workflow history corrected**: the original `asset-request.yml`
   issue-event run (run #920) was cancelled by the concurrency queue, and the later
   queue / stage / completion comments on issue #2567 came from a follow-up
   issue-triggered ingest pass rather than a manual `workflow_dispatch`. That later
   run produced brief `raccoon-bottle-rocketeer-v2` and published selected variants
   toward the `assets/queue` branch via `sprites:publish-selected`.

## Key Decisions Made

1. **Version-aware runtime resolution needed**: the issue pipeline produced
   `raccoon-bottle-rocketeer-v2`, not a bare `raccoon-bottle-rocketeer` brief. This PR
   adds live-registry resolution that prefers a dedicated bare-id brief first, then the
   newest approved `raccoon-bottle-rocketeer-vN` brief, before falling back to the
   existing `'raccoon-bottle-rocketeer': 'raccoon-thief'` alias.

2. **Front-facing sensor**: the issue brief explicitly requires "front-facing", so
   `sensors.enemy.facing: front` with `toleranceDeg: 25` was set.

3. **Dark palette with single accent**: matching the raccoon family's Floor 2 dark
   aesthetic (from `raccoons-boss.yaml`) while adding one weapon-tip accent to ensure
   the explosive-specialist identity reads at 64 × 64.

4. **Default size**: issue specifies `Size: default`; no `sizeVariant` override required.

## Wiring

The enemy `raccoon-bottle-rocketeer` already exists in `src/shared/data/enemies.floor2.json`
with `aiType: "ranged"` and `familyId: "raccoons"`. Wiring now resolves as follows:

- Before art ships: entity uses `raccoon-thief` sprite as fallback (live-registry path
  short-circuits to `raccoon-thief` via the alias table).
- After art ships (when `raccoon-bottle-rocketeer-vN-var-M` appears in the generated
  manifest): `generatedBriefIdForEnemy(...)` prefers the newest approved
  `raccoon-bottle-rocketeer-vN` brief from the live registry, so the enemy resolves to
  dedicated art even though the pipeline minted a versioned brief id.

## Verification

- YAML parsed clean: `python3 -c "import yaml; yaml.safe_load(open('briefs/enemies/raccoon-bottle-rocketeer.yaml'))"` ✅
- Fingerprint cross-verified with Node.js one-liner matching `b2bacbeb...` against the
  raw apostrophe issue body from GitHub issue #2567 ✅
- `npm run verify:pr-prereqs` was not run (no tsx locally); CI will exercise tests.
- Observe-before-done note: the generated sprite must be confirmed rendering in-game
  (`npm run dev` or headless probe) after the `assets/queue` PR merges. The wiring
  is automatic but the visual read (silhouette, palette, scale) needs a human eyeball.

## What's Next / Blockers

- The `assets/queue` publication path still needs the selected
  `raccoon-bottle-rocketeer-v2` variants from run `2026-08-01T05-52-41-a1eae295` to land
  in the shipped generated manifest.
- Once art lands, confirm the raccoon family sprites render at the same scale as siblings
  in the Floor 2 combat scene.
- No further wiring PRs should be needed for this enemy lineage; the version-aware
  live-registry path handles the shipped `-vN` brief id.
