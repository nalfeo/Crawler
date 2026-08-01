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

1. **Wiring code change required after art ships**: the issue pipeline synthesizes versioned
   brief IDs (e.g. `raccoon-bottle-rocketeer-v1`). `generatedBriefIdForEnemy` probes
   `registry.variants('raccoon-bottle-rocketeer')` first, but the registry groups entries
   by the `briefId` in the manifest — a versioned entry like `raccoon-bottle-rocketeer-v1`
   is NOT found by the bare key probe. Once the approved entry's `briefId` is known (e.g.
   `raccoon-bottle-rocketeer-v1`), update line 645 of `src/shared/generated-assets.ts`
   from `'raccoon-bottle-rocketeer': 'raccoon-thief'` to
   `'raccoon-bottle-rocketeer': 'raccoon-bottle-rocketeer-v1'` (using the actual approved
   `briefId`). Without this code change the raccoon will continue using `raccoon-thief`
   as its placeholder art even after dedicated sprites land in the registry.

2. **Front-facing sensor**: the issue brief explicitly requires "front-facing", so
   `sensors.enemy.facing: front` with `toleranceDeg: 25` was set.

3. **Dark palette with single accent**: matching the raccoon family's Floor 2 dark
   aesthetic (from `raccoons-boss.yaml`) while adding one weapon-tip accent to ensure
   the explosive-specialist identity reads at 64 × 64.

4. **Default size**: issue specifies `Size: default`; no `sizeVariant` override required.

## Wiring

The enemy `raccoon-bottle-rocketeer` already exists in `src/shared/data/enemies.floor2.json`
with `aiType: "ranged"` and `familyId: "raccoons"`.

- Before art ships: entity uses `raccoon-thief` sprite as fallback (alias table entry
  `'raccoon-bottle-rocketeer': 'raccoon-thief'` at line 645 of `src/shared/generated-assets.ts`).
- After art ships: a **manual code change is required**. The issue pipeline synthesizes a
  versioned `briefId` (e.g. `raccoon-bottle-rocketeer-v1`). `generatedBriefIdForEnemy`
  probes `registry.variants('raccoon-bottle-rocketeer')` first but the registry groups
  by exact `briefId`, so a versioned entry is never found by the bare key. Update the
  alias to the approved entry's `briefId`:
  ```typescript
  // src/shared/generated-assets.ts line 645
  'raccoon-bottle-rocketeer': 'raccoon-bottle-rocketeer-v1',  // use actual approved briefId
  ```

## Verification

- YAML parsed clean: `python3 -c "import yaml; yaml.safe_load(open('briefs/enemies/raccoon-bottle-rocketeer.yaml'))"` ✅
- Fingerprint cross-verified with Node.js one-liner matching `0e13b752...` ✅
- `npm run verify:pr-prereqs` was not run (no tsx locally); CI will exercise tests.
- Observe-before-done note: the generated sprite must be confirmed rendering in-game
  (`npm run dev` or headless probe) after the `assets/queue` PR merges. The visual
  read (silhouette, palette, scale) needs a human eyeball.

## What's Next / Blockers

- The `assets/queue` PR (#2558) needs the new `raccoon-bottle-rocketeer-var-0.png` to
  appear after the workflow drains. Watch `gh run list --workflow asset-request.yml` for
  the next successful run triggered by this workflow_dispatch.
- Once art lands, **a wiring PR is required**: update `src/shared/generated-assets.ts`
  line 645 to map `'raccoon-bottle-rocketeer'` to the approved entry's `briefId` (e.g.
  `'raccoon-bottle-rocketeer-v1'`). Check the manifest entry's exact `briefId` field
  before updating.
- Confirm the raccoon family sprites render at the same scale as siblings in the Floor 2
  combat scene after the wiring PR merges.
