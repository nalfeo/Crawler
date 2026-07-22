# Session Handoff: cactusfolk-boss Sprite Brief Update

## Date

2026-07-17

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, floor2-enemies

## Apples

1🍎 exact — pure art task: brief redesign + catalog description update. No engine code touched.

## What Was Done

Handled issue #1262 for the `cactusfolk-boss` (Abuela Saguaro) sprite asset. The existing
`briefs/enemies/cactusfolk-boss.yaml` described a dark crime-boss aesthetic (upright saguaro
silhouette, chain-mail, rusted plating, battered crown) that diverged from the issue's intent.
The issue requests Abuela Saguaro as an elderly grandmother character.

1. **Brief redesigned**: Updated `briefs/enemies/cactusfolk-boss.yaml` to match the issue's
   character design:
   - Stooped, hunched-forward posture (replaces "towering upright")
   - Deeply wrinkled and weathered green flesh
   - Small wire-rimmed spectacles
   - Faded floral rebozo/shawl draped over one shoulder
   - Devotional charms and trinkets at the rebozo fringe
   - Salvage-armor dressing that coordinates with — never buries — grandmother age cues
   - Added `sizeVariant: large` (issue requests Size: large → 128×128 output)
   - Changed `facing: front` (boss encounters face the player; matches batfolk-boss / geese-boss pattern)
   - Added `judge.enabled: true` and `maxVariants: 4` (boss quality gating)
   - Rewrote all 4 variations to reflect the new character design

2. **Sprite catalog updated**: Replaced the generic description for `generated:cactusfolk-boss-var-1`
   with a rich description matching the new character identity.

3. **verify:fast passed**: 1260 tests pass, all guards green.

4. **Did NOT regenerate**: Azure OpenAI credentials are not available in this CI environment.
   The existing `cactusfolk-boss-var-1.png` (64×64, generated from the old brief) remains the
   active runtime sprite. The updated brief is the canonical source for the next generation run,
   which must be triggered via the `asset-request` GitHub Actions workflow.

## Key Decisions Made

1. **Updated brief in place, not versioned** — the character identity was being corrected, not
   evolved. The grandmother aesthetic was always the issue's intent. No `v2` versioning needed.

2. **sizeVariant: large** — the issue explicitly requests Size: large. A 128×128 sprite gives
   4× the pixel budget of the existing 64×64 artifact, appropriate for a boss displayed at
   spriteWidth/Height 2.8 game-feet.

3. **facing: front** — all Floor 2 boss encounters face the player directly. The old brief used
   `facing: right`, which would have generated a side-facing boss.

4. **minVariations: 2 (not 4)** — large sizeVariant yields 4 cells per 1024px sheet; 2 is adequate
   per the geese-boss precedent.

## What's Already in Place (No Changes Required)

- Mob definition: `enemies.floor2.json` has `"id": "cactusfolk-boss"`, `"name": "Abuela Saguaro"`,
  `isBoss: true`, `familyId: "cactusfolk"` ✅
- Engine wiring: `src/shared/generated-assets.ts` line 414 maps `'cactusfolk-boss': 'cactusfolk-boss'` ✅
- Floor 2 scenario: `setEnemyAppearanceKey` with `archetype.id = 'cactusfolk-boss'` routes correctly ✅

## What's Next / Blockers

- **Regenerate sprites**: Trigger the `asset-request` GitHub Actions workflow with
  `brief_id: cactusfolk-boss`. The updated brief will produce 128×128 variants with the
  grandmother design. Review and approve via the sprite-judge workflow.
- **Replace var-1**: Once a new large-format sprite is approved and checked in, update the
  manifest entry and sprite catalog to retire `cactusfolk-boss-var-1` (64×64, old design).

## Retrospective

### Lessons Learned

- When a boss brief was authored before the full character brief was available, it may need
  a meaningful redesign — not just parameter tweaks. Always compare the existing brief against
  the issue's character description before assuming the brief is correct.

- The `sizeVariant: large` field is easy to omit from the first-pass brief. Cross-check the
  issue's "Size" field and encode it explicitly in the YAML.

### Mistakes Made

- The first pass treated the existing brief as authoritative before comparing it with the
  issue's full character description and size requirement.

### Opportunities for Future Improvement

- A brief-vs-issue validator could flag when a brief's prose diverges significantly from the
  issue's description text, prompting a review before the first generation run.
