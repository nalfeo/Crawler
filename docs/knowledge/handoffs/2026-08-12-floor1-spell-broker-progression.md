# Handoff — Floor 1 Spell Broker progression

## Systems touched

quests, ai-behavior-tree, vfx, inventory, weapons

## Summary

- Added an authoritative deterministic Floor 1 Spell Broker using three unique offers sampled from the existing ten-spell pool.
- Tuned the shared broker price to 35 gold and enforced offer, quest, affordability, ownership, and active-slot validation.
- Added ten spell-use skills with twenty thresholds and reusable efficacy scaling: small per-level gains plus stronger level 5/10/15/20 breakpoints.
- Spell activation now emits exactly one `spell_used` usage event for successful player activations; all ten spells route their output through the shared modifier layer.
- Added a seeded 25% AI spell-purchase intent that competes with optional merchant weapon purchases and is wired through the NPC interaction path.
- Extended the skill and AI labs with controls for spell-skill usage and the 25% broker toggle.

## Apples

- Estimated: 4🍎
- Actual: 4🍎

## Validation

- `npm run typecheck` ✅
- `npm run format:check` ✅
- `npm run lint -- --quiet` ✅
- `npx vitest run tests/game/spell-broker-progression.test.ts` ✅
- `npx vitest run --project headless tests/headless/floor1-completion.test.ts` ✅ (133 tests)
- Focused skill/ability/floor scenario tests ✅
- `npm run verify:fast` ✅

## Observe before done

- The real headless Floor 1 pipeline completed its existing gate after the broker, AI, and spell activation wiring were added.
- The focused progression tests observe deterministic offers, one-purchase semantics, seeded 25% intent, activation events, breakpoint scaling, and representative fireball output.

## Notes

- No new spell catalog entries or VFX were added; the existing ten spells and activation/VFX pipeline are reused.
- No pull request was created.
