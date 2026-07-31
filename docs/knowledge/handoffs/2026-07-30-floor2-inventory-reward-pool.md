# Session Handoff: Floor 2 Inventory Reward Pool

## Date

2026-07-30

## Persona

Producer -> Systems Engineer / UX integration recovery

## Systems touched

quests, inventory, weapons

## Apples

4 apples estimated, 5 apples actual. The inherited implementation required recovery,
two bounded review loops, legacy-save compatibility fixes, and a final overlapping rebase
onto main's newer acquisition-seam implementation.

## What Was Done

- Centralized the Floor 2 generated-equipment reward pool at 88 bases and added the 18
  Basic Leather generator-only bases.
- Converted all 36 Floor 2 achievement rewards to explicit generated-equipment loot boxes.
- Preserved exact generated instances through inventory projection, rendering, sorting,
  tooltips, carryover, claiming, and equipping.
- Kept Common legality fail-closed by filtering inherent non-armor bonuses before selection
  and retaining a tested post-generation tripwire before transaction commit.
- Preloaded one deterministic approved, non-placeholder Basic Leather variant under each
  of the 18 stable runtime art keys. The shipped-manifest integration test verifies every
  PNG exists.
- Preserved old tier4 bundles and pending presentations for exactly
  `floor2-family-annihilator`, `floor2-floor-cleared`, and `floor2-scorched-earth`, including
  exact-instance claimability. Non-allowlisted tier mismatches still fail closed.
- Rebased onto main's newer `onEquipItem` and acquisition-seam work, retaining its
  floor-agnostic probes while preserving exact generated-instance APIs.

## Pool Composition

| Tier / possible rarity | Eligible | Weapons | Non-weapons | Accessories |
| ---------------------- | -------: | ------: | ----------: | ----------: |
| tier1 / Common         |       66 |      56 |          10 |           0 |
| tier2 / Common         |       66 |      56 |          10 |           0 |
| tier2 / Uncommon       |       88 |      56 |          32 |           9 |
| tier3 / Common         |       66 |      56 |          10 |           0 |
| tier3 / Uncommon       |       88 |      56 |          32 |           9 |

Tier1 is Common-only and serves 13 of 36 achievements. Its 66-base pool is broad and not
single-category, so it fixes the narrow repeated-weapon defect, though it remains
weapon-heavy (56/66) and has no accessories because of the Common stat contract.

## Regression and Runtime Evidence

- **InventoryUI revert sensitivity:** temporarily reverting the generated-aware projection
  to `bag.slots` made
  `MainGameScene Floor 2 Quartermaster purchase UI > renders and equips the exact generated Quartermaster purchase through the inventory grid`
  fail in `tests/e2e/main-game-scene-quartermaster.test.ts`: the purchased immutable
  instance had no rendered cell. Production code was restored afterward.
- **Real Quartermaster flow:** the real `MainGameScene` purchase returned an immutable
  instance key; the exact inventory cell rendered; a real canvas double-click equipped the
  same key.
- **Real achievement flow:** claiming `floor2-safe-harbor` returned one generated instance;
  after acknowledging the reward-opening surface, its exact inventory cell rendered and a
  real canvas double-click equipped it.
- Durable browser witnesses are in `tests/e2e/main-game-scene-quartermaster.test.ts` and
  `tests/e2e/reward-opening-ux.test.ts`.

## Review and Validation

- Adversarial plan review: 6 concerns, 6 resolved, major fork.
- Single-model code review: 5 concerns across two rounds, all resolved.
- Multi-model review (`claude-sonnet-5`, `gpt-5.3-codex`,
  `gemini-3.1-pro-preview`) with GPT-5.4 adjudication: 4 valid concerns across two
  rounds, all resolved.
- Two-model post-rebase validation found no integration concerns.
- Targeted unit, game, integration, real-manifest, and browser witnesses passed.
  `npm run verify:fast` passed after the final rebase.

## Key Decisions

- Legal Common narrowing never mutates a base or generated instance, so stats cannot vary
  by provenance.
- Empty rarity/alignment subsets and illegal authored content throw rather than falling
  back.
- Stable art aliases select the lowest brief version, then lowest variant, deterministically.
- Legacy tier4 compatibility uses one shared exact-ID allowlist and preserves already
  generated instances verbatim instead of coercing or rerolling them.

## What's Next / Blockers

No product blocker. Publish the ready-for-review PR and arm squash auto-merge. Related
follow-up issues #2362, #2364, #2366, #2367, #2370, and #2371 remain out of scope.
