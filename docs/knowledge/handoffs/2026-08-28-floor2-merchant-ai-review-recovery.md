# Floor 2 merchant AI review recovery

## Systems touched

ai-headless-runner, floor2

## Summary

Recovered review feedback for the Floor 2 headless CLI merchant-routing default.
The CLI now resolves its Floor 2-only routing default in a pure helper and
passes that resolved option to the runner without disabling its normal
playability invariant.

## Verification

- `npm run test:unit -- tests/unit/ai/headless-runner-cli-lib.test.ts`
- `npm run typecheck`
- `npm run lint -- src/game/ai/headless-runner-cli.ts src/game/ai/headless-runner-cli-lib.ts tests/unit/ai/headless-runner-cli-lib.test.ts`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-28-floor2-merchant-ai.review-ledger.json`

## Unresolved issues

None.
