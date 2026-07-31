# Handoff: PR #2365 silent-revert guard recovery

**Date:** 2026-07-31  
**Session slug:** pr2365-silent-revert-guard-recovery  
**Issue/PR:** nalfeo/Crawler#2365  
**Apple estimate:** 2🍎

## Systems touched

ci-policy

## What was done

- Restored `scripts/agent/health/test-only-exports.ts` to the current `origin/main` version so PR #2365 no longer carries a stale merge result for the test-only export guard wrapper.
- Kept the branch-local inventory-lane work unchanged; the fix only re-applies the upstream wrapper that the silent-revert guard expected to see after the prior merge from main.
- Unshallowed the local clone and refreshed `origin/main` so the history-based silent-revert guard could run deterministically in this sandbox.

## Files touched

- `scripts/agent/health/test-only-exports.ts`
- `docs/knowledge/handoffs/2026-07-31-pr2365-silent-revert-guard-recovery.md`

## Verification

- `git diff origin/main -- scripts/agent/health/test-only-exports.ts` ✅
- `npx prettier --check src/engine/InventoryUI.ts scripts/agent/health/test-only-exports.ts` ✅
- `git diff --check` ✅
- `npx tsx scripts/agent/health/silent-reverts.ts` ✅ (`0 blocking`; remaining findings are warn-only historical discards)
- `npm run verify:pr-prereqs` ✅
- `npm run verify:fast` ⚠️ environment-blocked: local repo dependencies are not installed in this sandbox, so the script falls back to transient `npx` packages and then fails to resolve the repo's pinned TypeScript/ESLint modules.
- `npm run sync:main -- --reason pre-publish` ✅ with warning: automatic rebase attempt conflicted on the original inventory-lane commit and was aborted cleanly; HEAD was left unchanged.

## Unresolved issues

- `npm run verify:fast` still requires the repository's real installed dependencies in this sandbox.
- `npx tsx scripts/agent/health/silent-reverts.ts` still reports several warn-only historical discards on unrelated files, but there are no remaining blocking findings.
