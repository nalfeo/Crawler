# Session Handoff: AI Reward Opening Auto-Ack Coverage

## Date

2026-08-19

## Persona

QA Engineer

## Systems touched

hud-ux, labs, ai-runner

## Apples

2🍎 estimated, 2🍎 actual

## Verdict

Recommended — the PR fix already added the AI-driven reward-opening auto-acknowledge path; the review blocker correctly asked for deterministic real-scene regression coverage instead of source-string-only assertions.

## What changed

Added deterministic real-scene coverage to `tests/e2e/reward-opening-ux.test.ts` proving the reward-opening summary auto-acknowledges only for AI-driven runs:

- the test boots the real `MainGameScene` through `main-scene-probe-lab`;
- resolves the opening loadout modal so the reward-opening freeze branch is actually reached;
- drives the reward overlay to `summary`;
- samples 59 + 1 render updates with the probe-controlled `isAutoDriven()` flag enabled;
- asserts the overlay stays open before the hold threshold and closes synchronously on the threshold;
- asserts manual mode is not auto-driven and remains open after the same number of render updates.

The probe gained a minimal synchronous render-frame helper that calls the real `MainGameScene.update()` reward-opening branch rather than calling `RewardOpeningUI.tick()` directly, so the test exercises the shipped auto-driver and `acknowledge()` path.

## Validation

- `bash scripts/agent/preflight.sh`
- `npx vitest run tests/unit/ai-reward-opening-ux-wiring.test.ts`
- `npm run test:e2e -- tests/e2e/reward-opening-ux.test.ts -t "auto-acknowledges"`
- `npm run test:e2e -- tests/e2e/reward-opening-ux.test.ts`
- `npm run typecheck`
- `npm run lint`
- `npm run verify:fast`
- Secret scan on changed files: clean
- Automated code review: clean after clarifying probe/test comments

## Notes

The CI review validator child inspected the already-modified local worktree and therefore reported the newly-added e2e as pre-existing coverage. Treat the original review finding as valid for PR #3123's prior diff: before this session, only the source-string wiring test covered the auto-ack driver.
