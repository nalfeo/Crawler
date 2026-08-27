# Handoff: Restore Floor 1 release sweep victory

## Date

2026-08-25

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-headless-runner

## Apples

3🍎 estimated, 3🍎 actual.

## Summary

Fixed the Floor 1 Fireball seed 13 timeout from release sweep
`32787161346` (`project:sweep-results-viewer runId=32787161346`).

The newly wired mid-run loot sweep changed pickup/combat ordering and exposed
an existing repeat-purchase contract mismatch: the broker intent treated gold
reserved for a pending merchant weapon as spendable, but the purchase executor
correctly rejected the spell. The behavior tree repeatedly returned to the
broker until its NPC-progress watchdog suppressed navigation.

`BehaviorTreeAI` now provides `merchantWeaponReserve(world)` to
`updateSpellBrokerIntent`. The intent subtracts that reserve only for repeat
spells, matching the executor while preserving the first spell's priority over
the weapon. No loot-sweep radius, priority, success gate, or gameplay
requirement changed.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `src/game/ai/spell-broker-intent.ts`
- `tests/game/spell-broker-progression.test.ts`
- `tests/headless/floor1-release-sweep-loss-regressions.test.ts`

## Verification

- Real headless artifact, before:
  `npm run ai:headless -- --seed 13 --weapon fireball --floor floor1 --progress 0`
  timed out at 826.2s with `floor1-leave-floor` incomplete.
- Real headless artifact, after: the same command reached victory at 503.5s;
  it bought the pending weapon and repeat spell, then completed
  `floor1-leave-floor`.
- `npx vitest run tests/game/spell-broker-progression.test.ts --reporter=verbose`
  — passed (35 tests).
- `npx vitest run --project headless tests/headless/floor1-release-sweep-loss-regressions.test.ts --reporter=verbose`
  — passed (6 official victories, including Fireball seed 13).
- `npm run verify:fast` — passed.

## Unresolved issues

None.

## Recommended next steps

Let CI run the release and required PR checks. Do not remove the repeat-spell
reserve check: it is the intent/executor contract that prevents broker-return
loops when a merchant weapon remains pending.
