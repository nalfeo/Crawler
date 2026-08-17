# Handoff — AI lock-in CI recovery

## Systems touched

ai-behavior-tree, ai-combat-balance

## Summary

- Investigated PR #3035 CI failures from run `32052331055` using GitHub Actions logs.
- Confirmed `Lightweight Checks`, `Merge gate`, and aggregate `ci` were downstream of a GitHub GraphQL 503 in the human-approval check, while `Headless Floor 1 Gate` exposed a real regression: forced throwing-knife seed 39 died instead of winning.
- Verified `origin/main` is an ancestor of the branch head and `git merge origin/main` is already up to date; the sync helper's rebase warning is replay-only for an older branch commit.
- Preserved the lock-in invariant for spawner arenas and ordinary boss lock-ins, but restored the prior point-blank boss-contact escape carve-out when the lock-in boss itself is body-blocking the low-HP player with a long nominal attack range.
- Added unit coverage for the boss-contact carve-out alongside the existing spawner low-HP ENGAGE assertion.

## Verification

- `bash scripts/agent/preflight.sh` ✅ (sync helper warned on rebase replay conflict; typecheck passed)
- GitHub Actions failed job logs fetched via MCP ✅
- `npm test -- tests/unit/ai/bt-arena-lockin-priority.test.ts` ✅
- `npm run test:headless -- tests/headless/floor1-throwing-knife39-boss-contact-regression.test.ts` ✅
- `npm run test:headless -- tests/headless/ai-arena-lockin-resolution.test.ts` ✅
- `npm run verify:fast` ✅
- Secret scanning on modified source/test files ✅
- Automated code review ✅ (one comment wording issue fixed)
- CodeQL checker ✅ (0 alerts reported; JavaScript analysis skipped because database size was too large)

## Observe before done

- Before the repair, the real headless runner path reproduced the CI failure: forced throwing-knife seed 39 died deterministically at frame 15,361 in paired reruns.
- After the repair, the same real `runHeadless` regression passed with deterministic paired reruns, and the synthetic lock-in headless sweep still resolved 8/8 arenas with the low-HP pressure case staying under the retreat-loop bound.

## Unresolved issues

- None known for this recovery. CI should rerun on the pushed branch head.
