# Handoff: Restore Floor 1 throwing-knife seed 14 victory

## Date

2026-08-25

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-headless-runner

## Apples

3🍎 estimated, 3🍎 actual.

## Summary

The recurring Floor 1 release-sweep loss for forced throwing-knife seed 14 was
present in both compared 299/300 sweeps. After the final boss, organic gold
revived an abandoned repeat spell purchase and routed the runner away from the
stairs through a large enemy swarm.

Repeat spell recovery now stops after the staircase boss is defeated, and the
behavior tree prioritizes accepted exit navigation ahead of a stale repeat-broker
intent.

## Verification

- Real headless artifact before:
  `npm run ai:headless -- --seed 14 --weapon throwing-knife --floor floor1 --damage 1 --progress 0`
  died at 316.9s with `floor1-leave-floor` incomplete.
- Real headless artifact after the same command: victory at 298.3s with
  `floor1-leave-floor` complete.
- Focused broker lifecycle test: 36 passed.
- Focused returning-repeat intent exit-routing test: passed.
- Paired seed-14 regression: passed.
- Shared Floor 1 release-loss matrix: 10 passed.
- `bash scripts/agent/verify-fast.sh`: passed (2,368 tests).

## Unresolved issues

None.
