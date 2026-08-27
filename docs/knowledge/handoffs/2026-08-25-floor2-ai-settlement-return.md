# Handoff: Floor 2 AI settlement return

## Systems touched

ai-behavior-tree, inventory

## Summary

Fixed the visual AI Runner's Floor 2 auto-player never choosing to return to the
settlement for rewards and equipment maintenance. The lab now enables the
existing deterministic settlement-return router before each automated AI poll,
resets it during manual takeover, and re-enables it when AI control resumes.

The lab also mirrors the headless runner's eager-maintenance contract by leaving
achievement rewards unclaimed while return routing is active. This preserves the
router's utility signal until the settlement planner handles the reward on
arrival. Decision-mode semantics, router utility tuning, and headless defaults
are unchanged.

## Runtime evidence

The reported run bundle could not be downloaded because the Azure hostname was
unresolvable from the session. The issue's dev-build observation and the
pre-change wiring both showed the router was never configured in the visual lab.

After the fix, the real browser AI Runner ran Floor 2 seed 92 at 16x with
`objectivePortfolio` selected. It chose
`Returning to the settlement to run maintenance (equip/shop/claim)` at frames
2,187, 2,251, and 2,315. The existing real headless pipeline regression also
completed the full `armed -> traveling -> arrived -> resuming -> cooldown`
lifecycle.

## Verification

- Focused lab wiring/lifecycle tests: 8/8 passed.
- Settlement-return headless integration tests: 8/8 passed.
- `npm run typecheck:src`: passed.
- Targeted ESLint and Prettier checks: passed.
- `bash scripts/agent/verify-fast.sh`: 144 files / 2,368 tests passed.
- Separate-model plan review: 3 concerns resolved; minor plan divergence.
- Separate-model code review: clean.
- Changed files secret scan: clean.

## Apples

Estimated 3 apples; actual 3 apples. The estimate was exact: the fix required
visual-runner policy wiring, headless-parity maintenance behavior, deterministic
lifecycle coverage, real browser observation, and the 3-apple review harness.
