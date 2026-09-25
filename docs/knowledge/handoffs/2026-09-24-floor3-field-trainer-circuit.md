# Session Handoff: Floor 3 field Trainer circuit

## Date

2026-09-24

## Persona

Producer — coordinated Game Designer, Systems Engineer, UX, and QA seams in one bounded slice.

## Systems touched

enemies, ai-combat-balance, devtools

## What Was Done

- Added three visible, authored Floor 3 field Trainers (Mara, Oren, and Sable), with escalating 2/2/3-Companion teams and guaranteed 12/18/25-gold victory rewards.
- Trainers are placed as ordinary visible NPCs. The next unbeaten Trainer starts only when the player walks into its 14-ft encounter radius; no attack, ability, or direct Companion command is added.
- Trainer teams reuse the shipped automatic Companion AI/combat pipeline. Their KOs use the existing rival-Companion reward track, producing normal XP crystals; the player and party gain XP by collecting those crystals.
- Trainer wins are latched, their roster is removed permanently, their NPC dialogue changes, and the existing poach picker offers one of the defeated roster members. This makes the party/HUD visibly grow through the normal recruitment path.
- Added deterministic unit, headless-runner, and real `MainGameScene` probe coverage. The real-scene e2e captures `files/floor3-field-trainers.png`, showing the rendered Floor 3 scene after movement starts a Trainer roster.
- Recorded the requested next-slice TODOs in the Floor 3 design: companion equipment, plus player support skills that level from Companion battles without creating a player attack or direct Companion-command mechanic.

## Key Decisions Made

- Reused existing roster spawning, KO/reward, poach, and party-HUD contracts rather than introducing a new combat or reward system. This keeps the automatic-combat rule deterministic and avoids a new ECS-system/lab burden.
- The field circuit is separate from Studios/Final Four: it introduces recruitment choices before the existing Studio objective, and does not change Studio order-gating.
- If map generation has fewer spare territory rooms than challengers, Trainers are spread across deterministic tiles in the fallback room so entering one radius cannot start the next encounter.

## Validation

- `npx vitest run tests/unit/floor3-field-trainers.test.ts tests/unit/floor3-poach-offer.test.ts tests/unit/floor3-companion-rewards.test.ts` — 22 passing.
- `npm run test:headless -- tests/headless/floor3-field-trainers.test.ts` — passing.
- `npm run test:e2e -- tests/e2e/floor3-field-trainers.test.ts` — passing; browser screenshot inspected.
- Targeted ESLint, `npm run typecheck:src`, `npm run scope`, and `scripts/agent/lab-gate-check.sh` — passing.
- Full `npm run typecheck` remains blocked by the pre-existing unrelated `tests/helpers/floor5-objective-input.ts:135` `DamageOrigin` mismatch (`'weapon'` is no longer accepted).

## Next Steps

- Build the recorded companion-equipment and player-support-skill slice separately; retain the no-player-attack/no-direct-Companion-command rule.
- Tune trainer levels/rewards only through the Floor 3 balance-sweep process; this slice intentionally uses authored early/mid/late bands without changing global balance gates.
