# Handoff — Spellcraft passive tooltip

## Systems touched

abilities

## Summary

- Made the Level 5 `spellcraft-bolt-base` passive grant its declared `+0.1` accuracy while a spellcraft weapon is equipped.
- Added the player-facing effect and requirement summaries so the ability loadout no longer falls back to the vague “Effect bonus” label.
- Added registry coverage that keeps the tooltip wording, prerequisite, and applied effect aligned.

## Apples

- Estimated: 2🍎
- Actual: 2🍎
- Verdict: 🎯 Exact — the reported tooltip gap required one ability-definition correction and focused coverage.

## Validation

- `npx vitest run tests/game/ability-registry.test.ts` ✅
- `npm run verify:fast` ✅

## Observe before done

- Before: the supplied run `4b5003bc-0827-40df-bc37-71373a5a42f2` reported a Spellcraft passive detail that fell back to “Basic spell bolt” / “Effect bonus”.
- After: the real game’s `MainGameScene` reads the corrected registry fields for its passive row, producing `Accuracy +0.1` and the spellcraft-weapon requirement; the registry regression test verifies that exact runtime input.
- `npm run dev -- --host 127.0.0.1` served the real game successfully at `http://127.0.0.1:23360/`. The sandbox browser transport closed before an interactive capture could be taken.
