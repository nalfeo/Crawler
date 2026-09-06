# Floor 2 Boss Survival

## Summary

Floor 2 den bosses died before any telegraphed mechanic could read (issue
#4291). The live spawn path applied a 0.03 HP scale, shrinking a 220 HP boss to
7 HP. The fix derives the live scale from measured headless time-to-kill instead:
the shipped multiplier is 4× the authored archetype HP, which is the smallest
whole multiplier that keeps every den boss alive past its own signature-ability
window while all three gate seeds still reach `victory`.

## Systems touched

enemies, boss-rooms, ai-combat-balance

## Evidence (headless, `BehaviorTreeAI`, seeds 1–3, floor2)

Per-den time-to-kill (`encounterStartedMs` → `encounterDefeatedMs`) versus the
family's signature-cycle window (`firstEligibleAfterMs + telegraph.durationMs`
from `src/shared/data/boss-abilities.floor2.json`, 9.25 s–12.5 s):

| HP scale | measured TTK     | verdict                                            |
| -------- | ---------------- | -------------------------------------------------- |
| 0.03     | one melee volley | boss dies before any telegraph                     |
| 1×       | 5.5–6.7 s        | still below every ability window                   |
| 3×       | 9.4–19.6 s       | goblins @ lv19 cleared 9.25 s by only 134 ms       |
| 4×       | 12.1–27.0 s      | ≥ 30 % margin on every window; 3/3 seeds still win |

All three seeds finish `outcome='victory'` with `floor2Progression.exitCompleted`
true at 4×, so completion viability is preserved.

## Key decisions

- Live Floor 2 boss HP = authored archetype HP × 4; the arena lab keeps its own
  debug scaling.
- No invulnerability, no seed-specific exception, telegraph readability
  unchanged.
- The duration target is read from the boss-ability catalog, so re-timing an
  ability automatically re-times the gate.

## Known scope limit

Production Floor 2 does not yet _execute_ the cataloged signature abilities —
`floor2-boss-production-enable` in
`scripts/agent/data/boss-abilities.floor2.status.json` is `not-started`, only 7
of 18 abilities have a verified runtime, and `registerMobAbility` /
`setMobAbilitiesEnabled` are wired for Floor 5 and the arena lab only. This
change delivers the durability half of #4291's acceptance criteria (the fight
window is long enough for the authored cycle) and gates it, so the separate
production-activation slice cannot land on bosses that die before their own
telegraph. The activation itself is escalated as a separate scope decision.

## Verification

- `npx vitest run --project headless tests/headless/floor2-boss-survival-gate.test.ts`
  (3 seeds, full Floor 2 victories, ~4 min)
- Negative check: reverting the scale to 1× fails the gate
  (`Boss died in 5517ms, before one 10200ms signature cycle`), so the gate has
  teeth.
- `npx vitest run tests/unit/floor2-boss-spawn.test.ts`
- `npm run typecheck`, `npx eslint` on the touched files

## Apples

3 estimated, 3 actual.
