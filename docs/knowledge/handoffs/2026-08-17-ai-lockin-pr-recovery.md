# Handoff — AI lock-in PR recovery

## Systems touched

ai-behavior-tree, ai-combat-balance, floor-scenarios

## Summary

- Merged `origin/main` into PR #3035 to clear the stale-base conflict.
- Split the unrelated feature-flagged Floor 1/Floor 2 trash-spawner placement work out of this AI lock-in PR by reverting its source and flag tests.
- Added a bounded headless regression that starts below the retreat threshold with nearby pressure and verifies the synthetic arena still resolves without a sustained retreat loop.
- Kept the existing BT unit coverage proving low-HP lock-in selects defensive `ENGAGE` on the arena objective instead of `RETREAT`.

## Files touched

- `src/game/ai/arena-lockin.ts`
- `src/game/ai/bt-ai-provider.ts`
- `docs/systems/04-enemy-ai.md`
- `tests/unit/ai/bt-arena-lockin-priority.test.ts`
- `tests/headless/ai-arena-lockin-resolution.test.ts`
- `src/game/floorScenario.ts`
- `src/game/floor2Scenario.ts`
- `tests/unit/floor2-environmental-content-wiring.test.ts`
- `scripts/agent/health/knip-suppressions.ts`

## Verification

- `bash scripts/agent/preflight.sh` ✅ (reported main-sync conflict before the manual merge; typecheck passed)
- GitHub Actions logs checked via MCP: latest CI Recovery Router failure was a transient GitHub 503 dispatch error, not a branch code failure.
- `npm run test:headless -- tests/headless/ai-arena-lockin-resolution.test.ts` ✅
- `npm test -- tests/unit/ai/bt-arena-lockin-priority.test.ts tests/unit/floor2-environmental-content-wiring.test.ts` ✅
- `npm run verify:fast` ✅

## Observe before done

- Before recovery, the headless resolution sweep only covered high-HP synthetic lock-ins, and review validation confirmed the unrelated floor-spawner feature was still bundled in the PR.
- After recovery, the real headless AI pipeline (`runSimulationStep` with canonical Floor 1 `preSystems`) resolves the arena from low HP plus nearby pressure, and the unrelated floor-spawner call sites/flag utilities are absent from the PR diff.

## Unresolved issues

- None known. CI may need to rerun after the consolidated repair push; the only inspected CI failure was GitHub's transient 503 while dispatching CI recovery.
