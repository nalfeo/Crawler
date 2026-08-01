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
     `0e13b752d8f337004ab0b8f3f84f5e84fbb7e2dac551533c9bf1dab52f048887`.

4. **GitHub Actions workflow triggered**: the `asset-request.yml` pipeline was re-triggered
   via `workflow_dispatch` because the original issue-event run (run #920) was cancelled
   by the concurrency queue. The workflow ingests the issue, generates sprites against
   Azure OpenAI, judges candidates, and publishes the winner to the `assets/queue` branch
   (PR #2558) via `sprites:publish-selected`.

## Key Decisions Made

1. **Brief-first, no runtime-alias edit needed**: `generatedBriefIdForEnemy` already
   auto-detects a dedicated sprite when `registry.variants('raccoon-bottle-rocketeer')`
   returns results — the existing fallback alias `'raccoon-bottle-rocketeer': 'raccoon-thief'`
   (line 645 of `src/shared/generated-assets.ts`) is bypassed the moment dedicated art
   ships, without any manual code change.

2. **Front-facing sensor**: the issue brief explicitly requires "front-facing", so
   `sensors.enemy.facing: front` with `toleranceDeg: 25` was set.

3. **Dark palette with single accent**: matching the raccoon family's Floor 2 dark
   aesthetic (from `raccoons-boss.yaml`) while adding one weapon-tip accent to ensure
   the explosive-specialist identity reads at 64 × 64.

4. **Default size**: issue specifies `Size: default`; no `sizeVariant` override required.

## Wiring

The enemy `raccoon-bottle-rocketeer` already exists in `src/shared/data/enemies.floor2.json`
with `aiType: "ranged"` and `familyId: "raccoons"`. Wiring is handled automatically:

- Before art ships: entity uses `raccoon-thief` sprite as fallback (live-registry path
  short-circuits to `raccoon-thief` via the alias table).
- After art ships (when `raccoon-bottle-rocketeer-var-N.json` appears in
  `public/assets/generated/entries/`): `registry.variants('raccoon-bottle-rocketeer')`
  returns the new sprite and no code change is needed.

## Verification

- YAML parsed clean: `python3 -c "import yaml; yaml.safe_load(open('briefs/enemies/raccoon-bottle-rocketeer.yaml'))"` ✅
- Fingerprint cross-verified with Node.js one-liner matching `0e13b752...` ✅
- `npm run verify:pr-prereqs` was not run (no tsx locally); CI will exercise tests.
- Observe-before-done note: the generated sprite must be confirmed rendering in-game
  (`npm run dev` or headless probe) after the `assets/queue` PR merges. The wiring
  is automatic but the visual read (silhouette, palette, scale) needs a human eyeball.

## What's Next / Blockers

- The `assets/queue` PR (#2558) needs the new `raccoon-bottle-rocketeer-var-0.png` to
  appear after the workflow drains. Watch `gh run list --workflow asset-request.yml` for
  the next successful run triggered by this workflow_dispatch.
- Once art lands, confirm the raccoon family sprites render at the same scale as siblings
  in the Floor 2 combat scene.
- No further wiring PRs are needed; the auto-detect path handles it.
