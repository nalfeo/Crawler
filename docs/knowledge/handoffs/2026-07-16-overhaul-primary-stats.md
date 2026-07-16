# Handoff: Primary stat-system overhaul

## Date

2026-07-16

## Persona

Producer -> Systems Engineer / Game Designer / QA Engineer

## Systems touched

ai-combat-balance, hud-ux, inventory, weapons, ci-policy

## Apples

5 apples estimated, 5 apples actual (exact).

## What changed

- Replaced the split `Stats` / `EffectiveStats` runtime with one canonical
  `EffectiveStats` derivation and read lane. Base primary stats, allocated points,
  equipment primary bonuses, and modifiers now fold through the same pure pipeline.
- Implemented the approved primary-stat contract:
  - Strength: +1% physical damage and +5 lb encumbrance capacity per effective point.
  - Dexterity: +1% attack speed, +0.25% movement, +0.25 percentage points accuracy,
    and +1/300 dodge per effective point.
  - Constitution: +10 max HP per effective point.
  - Intelligence: +1% magic strength per effective point.
  - Wisdom: +0.5 percentage points cooldown reduction per effective point, capped at
    80%.
  - Charisma: visible, inert, and non-allocatable.
  - Luck: +0.25 percentage points crit chance per effective point, capped at 100%.
- Removed Strength armor/flat-damage derivation, Intelligence projectile-speed
  derivation, Luck pickup-range derivation, and the primary `weight` row.
- Added fail-closed attack-creation snapshots for origin, physical/magic/unscaled
  affinity, primary-scaling eligibility, and crit eligibility. Projectile, beam,
  melee, area, trap, AoE-on-impact, direct-effect, enemy-fireball, and latent
  weapon-entity paths carry their snapshot through delayed hits.
- Added explicit inline scaling metadata for every magical ability output. Damage,
  healing, duration, radius, knockback, slow, and life-drain outputs resolve
  independently without double scaling.
- Removed mana vertically: world state, helper/constants, system/pipeline, `mpCost`,
  gating/spending, HUD/layout, presentation, data names, mana lab, exports, and
  tests. Spell unlock gating remains intact; abilities now use cooldowns and
  deterministic triggers only.
- Added required `weightLb` to every equipment definition (all current values are
  exactly 0 lb), unique multi-slot deduplication, body-plus-equipped mass,
  Strength-adjusted encumbrance thresholds, movement multipliers, and EquipmentUI
  weight/band display.
- Wired exact cadence and movement formulas:
  `baseCooldown/(1+attackSpeedBonus)*(1-CDR)` and
  `baseSpeed*(1+moveSpeedBonus)*statusMultiplier*encumbranceMultiplier`.
- Kept weapon personas disabled. The shared default allocator branches only on
  physical Strength versus magic Intelligence after shared Constitution and
  Dexterity survival targets.
- Added ADR/spec updates plus focused unit, property, ECS, integration, schema,
  structural-absence, and UI-layout coverage.

## Architecture and review decisions

- The adversarial plan review caused a `major_fork`: the initial dual-store migration
  became one final-stat lane, and source/loadout-dependent damage data moved into
  persistent attack payloads at creation time.
- Six alternatives were considered, including a dual-store strangler, source-only
  damage resolution, parallel output metadata, and mana neutering. Pure custom
  helpers plus existing Zod were retained because general stat/effect libraries do
  not fit the deterministic typed-array ECS or layer boundaries.
- The 5-apple review harness completed two code-review rounds and two distinct-model
  adjudicated rounds. Findings fixed max-HP delta drift, enemy AoE metadata,
  ability-schema bounds, latent weapon-entity metadata, and test type safety.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-16-overhaul-primary-stats.review-ledger.json`.

## Runtime evidence

Both broad measurements ran on GitHub Actions with seeds 1-100, personas disabled,
all six starter weapons, and `max_frames=19800`.

| Weapon         | Baseline wins | Baseline mean | Final wins | Final mean |
| -------------- | ------------: | ------------: | ---------: | ---------: |
| Sword          |        99/100 |        240.7s |     99/100 |     236.0s |
| Bow            |        96/100 |        247.2s |     95/100 |     237.5s |
| Baseball bat   |        97/100 |        252.4s |     96/100 |     244.3s |
| Pistol         |        97/100 |        242.2s |     96/100 |     230.8s |
| Throwing knife |        93/100 |        247.5s |     93/100 |     235.7s |
| Fireball       |       100/100 |        231.3s |    100/100 |     217.0s |

- Baseline: run `29483586088`, exact `main` SHA
  `2cca6f1037771f212add3f8b8669d9de66d8b7f0`.
- Final: run `29512277198`, SHA
  `231c3a8a3ce614be5ccacc507aaeb5d894e9503f`.
- Aggregate artifacts were captured under the session files directory.
- The first post-change sweep exposed physical-weapon deaths after Strength armor
  removal. Tuning stayed within the approved lanes: shared default allocation and
  the canonical base max-HP constant only. No seed, map, navigation, weapon,
  win-definition, frame-budget, or gate threshold changed.

## Caveats

- Fresh derived max HP is now 170 (`160` base floor + `10` from effective
  Constitution 1). This intentionally replaces broad survivability lost when
  Strength stopped granting armor.
- Current equipment weighs 0 lb, so real loadouts remain unburdened until the
  follow-up authored item-weight pass lands. Synthetic nonzero tests exercise every
  encumbrance band and multi-slot deduplication now.
- Weapon personas remain paused/default-off and were not tuned or enabled.

## Verification

- `npm run verify:fast`
- `npm run typecheck`
- `npm run review:ledger -- validate`
- Exact GitHub baseline and final 600-run weapon sweeps listed above

## Next

- File the required authored item-weight follow-up issue after the ready PR exists.
- Do not merge or arm auto-merge from this session.
