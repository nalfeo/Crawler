# 2026-07-18 CI Recovery Loop — Epic-State Stale Commit Fix

## Systems touched

`epics`

## What happened

The automated CI recovery loop for PR #1273 ("Queen Mab Verdigris Glamour") exhausted its two-attempt retry budget and filed loop-incident #1581.

**Root cause:** `docs/knowledge/epics/floor-2-equipment/epic-state.json` recorded evidence for `slice:A0` at commit `8cc19153bb8881a4faba5b696eb117c7abc820c2`. That commit was on the `copilot/floor-2-epic-control-plane` branch. After PR #1271 was squash-merged as `89ff7827ca65a9d1564dad451ec9d2a2f312a82e` and the source branch was deleted, `8cc19153` became unreachable in git history.

Any PR that touched `docs/knowledge/epics/**` triggered the `epic-drift-audit` CI workflow, which called `git show 8cc19153:tests/unit/agent/epic-status.test.ts` and received `null`, producing:

```
[evidence.git-verification-failed] slice:A0: evidence could not be verified at commit 8cc19153...
```

This was blocker #1 of 19 total blockers on PR #1273. With that plus 18 review threads, recovery agents couldn't clear all blockers within the 2-attempt window.

**No bug in the recovery automation itself.** The marker parser, `shouldResolveThread`, permission grant, and mutation sequence all worked correctly.

## Fix

- `docs/knowledge/epics/floor-2-equipment/epic-state.json`: changed `commit` for the `offline-validator-and-focused-tests` evidence from `8cc19153` → `89ff7827`. The `sha256` (`bbb2912c...`) was already correct (same file content exists at both commits).

## Regression test added

- `tests/unit/agent/epic-status-inaccessible-commit.test.ts`: two tests validating the squash-merge-residue failure mode:
  1. Verifies `evidence.git-verification-failed` is raised when `showContent()` returns null for an inaccessible commit SHA.
  2. Verifies the error is NOT raised when using the correct (accessible) squash-merge commit.

Tests were added in a separate file (not `epic-status.test.ts`) to avoid disturbing the existing sha256 contract check that enforces evidence freshness.

## Verification

- `npm run verify:fast` → 1260 tests, 87 test files, all pass
- `npm run epic:status -- floor-2-equipment` → `Offline schema/DAG: valid`, no errors

## Apple estimate: 2 🍎
