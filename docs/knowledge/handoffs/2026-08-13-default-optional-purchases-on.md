# Default optional AI purchases on

## Systems touched

ai-behavior-tree

## Summary

- Changed the shared headless-runner `optionalPurchases` default from off to on, arming both the merchant weapon and Floor 1 Spell Broker purchase decisions.
- Preserved explicit canonical and deprecated flag overrides while making the no-flag compatibility fallback inherit the new default.
- Updated the headless CLI and AI Runner lab defaults, including an explicit `--no-optional-purchases` CLI control.
- Updated focused regression coverage for the runtime fallback, CLI/environment controls, and lab toggle default.

## Apples

- Estimated: 2 apples
- Actual: 2 apples
- Verdict: Exact. The change remained a small default promotion with focused compatibility and test updates.

## Evidence

- The existing 100-seed A/B comparison showed win rate improving from 97% to 98% and fun score improving from 43.08 to 43.56.
- Control: `project:sweep-results-viewer runId=31670582294`
- Treatment: `project:sweep-results-viewer runId=31670587158`
- Both arms fail the same pre-existing Floor 1 challenge-balance, excitement, and pacing dimensions.

## Validation

- `npm run typecheck`
- `npx vitest run tests/unit/ai/optional-purchases-flag.test.ts tests/unit/ai/headless-runner-cli-lib.test.ts tests/unit/ai-runner-merchant-weapon-wiring.test.ts`
- `npm run verify:fast`

## Observe before done

- The real headless CLI reported `Optional purchases: enabled` with no purchase flag.
- The same real pipeline reported `Optional purchases: disabled` with `--no-optional-purchases`.
- Both one-frame observations intentionally ended with the runner's timeout exit because `--max-frames 1` was used.
