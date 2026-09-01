# Handoff: Floor 6 tower review recovery

## Systems touched

weapons, vfx

## Apples

2 apples estimated, 2 apples actual (exact). This was a localized runtime identity fix plus regression and lab coverage.

## Summary

- Pruned tracked Floor 6 tower effects by both entity liveness and `Floor6TowerEffect` component identity so recycled EIDs cannot consume effect capacity or inflate telemetry.
- Added a regression that recycles an expired effect EID into an unrelated entity and verifies the tower can still spawn up to its effect cap.
- Extended the existing Floor 6 defense parity lab to build a tower, place a live raider in range, run `floor6TowerSystem`, and report the resulting target hit and effect.

## Verification run

- `npx vitest run --project unit tests/unit/floor6-towers.test.ts`
- `npm run typecheck`
- `bash scripts/agent/verify-fast.sh`

## Real artifact observation

- Before: the Floor 6 defense parity lab only displayed initialization and wave-director data; it never built a tower or ran `floor6TowerSystem`.
- After: the running `floor6-defense-parity-lab` reported `build=built`, `targets hit=1`, `effects spawned=1`, and `active effects=1` for seed 606.

## Unresolved issues

None.
