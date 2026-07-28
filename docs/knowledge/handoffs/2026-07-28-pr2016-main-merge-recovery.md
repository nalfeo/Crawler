# Handoff: PR #2016 main-merge recovery

## Date

2026-07-28

## Persona

Producer

## Systems touched

enemies, ai-behavior-tree, ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Recovered PR #2016 by unshallowing the repo, fetching current `origin/main`, and merging it cleanly into `copilot/implement-don-pacos-the-big-gob-again` as `12f96a76`.
- Verified the named Don Paco review blockers were already present on branch head `b6c93b9`: pre-tick invalid-caster cleanup in `mobAbilitySystem`, the final-travel-frame death regression test, the slick-occupancy dodge preservation fix, ADR 0076, and the populated 4🍎 review ledger/apple/handoff artifacts.
- Confirmed the old-head authoritative PR validation was green; the only red checks were ancillary `CI Recovery Router` `route` jobs triggered by review-comment churn.
- Repaired local validation capability by temporarily rewriting Azure Artifacts tarball hosts in `package-lock.json` to `registry.npmjs.org` for `npm ci`, then restoring the lockfile before any commit.

## Files touched

- `docs/knowledge/handoffs/2026-07-28-pr2016-main-merge-recovery.md`
- merge commit `12f96a76` (`origin/main` into `copilot/implement-don-pacos-the-big-gob-again`)

## Verification

- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅
- `parallel_validation` ✅ (no review findings; CodeQL reported no alerts in analyzed ecosystems)
- `runtime-tools-secret_scanning` on files changed since the remote branch ✅

## Observe before done

- This session shipped no new gameplay logic beyond bringing the branch onto current `main`; verification focused on deterministic repo gates plus direct inspection of the already-landed Don Paco runtime/AI/test fixes on the branch.

## Notes / unresolved

- PR head is now `12f96a76fb3ef465e6d250038a7351d9a42a321f` and GitHub has started fresh checks for that head.
- All five Copilot review threads on PR #2016 are resolved upstream, so no new thread reply was posted in this session.
