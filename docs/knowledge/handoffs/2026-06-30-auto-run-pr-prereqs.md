# Session Handoff: Auto-run PR prerequisites in verify gate

**Date**: 2026-06-30  
**Apple estimate**: 2 🍎  
**Session branch**: `nalfeo-auto-run-pr-prereqs`

## Summary

Moved PR-readiness evaluation (review-ledger + preflight checks) from the `create_pull_request` gate to the full `npm run verify` flow. This surfaces blockers at execution-complete time instead of at PR-button time, eliminating the "surprise gate" pattern where the agent completes code work only to discover that review-harness must run first.

### Key Changes

1. **Extracted pure logic from `pr-preflight` guard**
   - Refactored `.github/extensions/copilot-guards/guards/pr-preflight.mjs` to expose `evaluatePreflightChecks()` as a reusable function
   - Checks remain the same (handoff, forbidden paths, lab gate, ADR) but now callable outside the guard dispatcher

2. **Added deterministic early gate**
   - Created `scripts/agent/review/pr-prereq-check.mjs`: CLI that evaluates current working tree (branch commits + staged + unstaged + untracked changes) against preflight + review-ledger requirements
   - Added `scripts/agent/review/pr-prereq-check.test.mjs`: 5 unit tests for gate logic

3. **Wired into verify pipeline**
   - Added `npm run verify:pr-prereqs` script to `package.json`
   - Integrated as step 9/10 in `scripts/agent/verify.sh` (before build)

4. **Updated documentation**
   - AGENTS.md: added command entry, noted verify includes prereq pass
   - .github/copilot-instructions.md: documented early PR-prereq pass
   - .github/skills/review-harness/SKILL.md: updated workflow to run reviews at completion time
   - docs/agent-os/policies/review-harness-policy.md: noted local verify:pr-prereqs enforcement
   - .github/extensions/copilot-guards/README.md: added note about early feedback via verify:pr-prereqs

## Files Changed

**Created**:

- `scripts/agent/review/pr-prereq-check.mjs`
- `scripts/agent/review/pr-prereq-check.test.mjs`

**Modified**:

- `.github/extensions/copilot-guards/guards/pr-preflight.mjs` (refactored to expose pure function)
- `scripts/agent/verify.sh` (added step 9/10)
- `package.json` (added verify:pr-prereqs script)
- AGENTS.md
- .github/copilot-instructions.md
- .github/skills/review-harness/SKILL.md
- docs/agent-os/policies/review-harness-policy.md
- .github/extensions/copilot-guards/README.md

## Verification

✅ All 5 pr-prereq-check tests pass  
✅ All 15 guard/preflight tests pass  
✅ `npm run verify:fast` passes (typecheck + lint + changed unit tests)  
✅ ESLint clean (0 errors)  
✅ Review ledger valid (2-apple, plan_review + code_review stages)

## Unresolved Issues

None. Implementation complete and ready for merge.

## Next Steps

1. Merge this PR
2. Agents now run `npm run verify:pr-prereqs` as part of the full `npm run verify` loop
3. Review-ledger and preflight blockers surface immediately at execution-complete time
4. No more surprises at `create_pull_request` — if verify passes, PR prerequisites are satisfied
