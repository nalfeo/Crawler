# Handoff: Floor 6 tower review recovery

## Systems touched

enemies, inventory, ai-behavior-tree

## Apples

2 apples estimated, 2 apples actual (exact). This was a focused review/CI recovery over existing Floor 6 tower construction, lab preview, and headless coverage.

## Summary

- Canonicalized `floor6Defense.towerInstances` after every successful build so tower combat and `RunStats.floor6Defense.towers` follow authored build-site order even when build requests arrive in reverse order.
- Removed unintended public exports for internal tower helpers, retaining underscore-prefixed seams only where tests/labs need deliberate access.
- Moved the Floor 6 parity lab preview build after the setup director tick so its funded tower spend survives subsequent ticks.
- Expanded the real headless Floor 6 tower request coverage to queue and assert all three starter towers on distinct authored sites.

## Files touched

- `src/game/floor6Scenario.ts`
- `src/labs/floor6-defense-parity-lab/index.ts`
- `tests/unit/floor6-towers.test.ts`
- `tests/headless/floor6-economy-obs.test.ts`

## Verification run

- `npm run test:unit -- tests/unit/floor6-towers.test.ts`
- `npm test -- tests/headless/floor6-economy-obs.test.ts`
- `npm run check:test-only-exports && npm run lint:dead-code`
- `npm run format:check -- src/game/floor6Scenario.ts src/labs/floor6-defense-parity-lab/index.ts tests/unit/floor6-towers.test.ts tests/headless/floor6-economy-obs.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

Observed before recovery: CI Lightweight Checks failed on test-only exports/dead-code, reverse-order builds serialized towers in transaction order, the lab preview could reset economy after building, and headless coverage queued only `signal-slinger`.

Observed after recovery: targeted unit/headless tests pass, export/dead-code checks pass, reverse-order unit coverage observes authored-site ordering, and the headless run builds `signal-slinger`, `relay-riveter`, and `crane-caster` through `floor6TowerBuildRequests`.

## Unresolved issues

- None known.

## Recommended next steps

- Let CI Recovery rerun the complete Lightweight Checks and resolve the addressed review threads.
