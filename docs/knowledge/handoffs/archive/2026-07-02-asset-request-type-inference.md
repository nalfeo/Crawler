# Handoff: Asset-Request Type Inference + Type Validation Guard

**Session Date:** 2026-07-02  
**Session ID:** 7277803c-5206-4508-93ef-2461e76a5c41  
**Branch:** nalfeo-shiny-invention  
**Complexity Estimate:** 2🍎

## Systems touched

quests

## Summary

Completed comprehensive asset-request type-inference feature with full validation gates across all entry points (form, JSON marker, queue deserialization). All prior code-review concerns resolved. Feature ready for merge.

## Work Done

### 1. Core Feature Implementation (Commit 1: 840a696b)

- **Added optional `--type` field to asset-request.yml template** with dropdown selector
- **Implemented type inference from naming patterns** in `issue-pipeline.ts::inferSpriteTypeFromName()`:
  - Weapon-\* prefix → `weapon` type
  - Ability-\* prefix → `ability` type
  - Lichen/plant/rock suffixes → `tile` type
  - Default fallback → `character` type
- **Updated queue message structure** to carry optional type field
- **Simplified error handling:** removed blocked-label guard (too coarse, trapped transient errors), replaced with diagnostic comments only
- **Pass explicit/inferred type to synthesizeBrief()** to bypass classifier 90% confidence gate

### 2. Interface Fix (Commit 2: 840a696b)

- **Removed unused `addLabel()` from IssuePipelineIssueApi interface** that was declared without implementation, causing TypeScript compilation failures

### 3. Comprehensive Validation (Commit 3: 8505d461)

- **Added SPRITE_TYPES validation to `isAssetRequestPayload()`** (JSON marker path):
  - Case-insensitive match against enum
  - Returns null if type is non-empty and invalid
- **Added SPRITE_TYPES validation to `normalizeAssetRequest()`** (queue deserialization):
  - Silent filtering: invalid types omitted (graceful degradation)
  - Types normalized to lowercase for consistency
  - Invalid types do not block the entire request
- **Comprehensive test coverage:**
  - `asset-request.test.ts`: Tests for form-rendered and JSON marker type validation paths
  - `asset-queue.test.ts`: Tests for queue layer validation and normalization
  - `issue-pipeline.test.ts`: Tests for type inference and explicit type usage

### 4. Review Ledger Recording (Commit 4: 79080cb)

- **Plan review (gpt-5.4):** 4 concerns identified, all addressed
- **Code review (claude-sonnet-4.6, 2 rounds):**
  - Round 1: 2 concerns (validation gaps at JSON marker and queue paths)
  - Round 2: All concerns resolved; clean verdict
- Ledger validated with `npm run review:ledger -- validate` → ✅ valid 2-apple ledger

## Files Touched

### Source Code

- `scripts/sprites/asset-request.ts` – Type validation in form/marker parse paths
- `scripts/sprites/queue/types.ts` – Type validation in queue deserialization
- `scripts/sprites/issue-pipeline.ts` – Type inference logic + interface fix
- `.github/ISSUE_TEMPLATE/asset-request.yml` – Added optional --type dropdown

### Tests

- `tests/unit/sprites/asset-request.test.ts` – New tests for form/marker type validation
- `tests/unit/sprites/asset-queue.test.ts` – New tests for queue validation
- `tests/unit/sprites/issue-pipeline.test.ts` – New tests for inference and explicit type

### Documentation

- `docs/knowledge/review-ledgers/2026-07-02-asset-request-type-inference.review-ledger.json` – 2🍎 review ledger with plan_review and code_review stages

## Verification

### Unit Tests

```
asset-request.test.ts: 8 tests (all passing)
asset-queue.test.ts: 16 tests (all passing)
issue-pipeline.test.ts: 5 tests (all passing)
Total: 28/28 passing
```

### Build & Type Checks

- `npm run typecheck` – ✅ No TypeScript errors
- `npm run verify:fast` – ✅ Passed (typecheck + lint + relevant unit tests)

### Review Harness

- **Plan Review (gpt-5.4):** 4 concerns → 4 resolved
  1. Type validation missing in parse paths ✅
  2. Overly broad inference patterns ✅
  3. Label mutation failures ✅
  4. Transient errors blocked permanently ✅
- **Code Review (claude-sonnet-4.6, 2 rounds):** 2 concerns → 2 resolved
  1. Type validation missing at JSON marker path ✅
  2. Type validation missing at queue deserialization ✅
- **Final Verdict:** clean=true, ready for merge

## Design Decisions

1. **Type Inference Heuristics:** Conservative pattern matching over ML—only explicit prefixes/suffixes, default to character. Avoids false positives.

2. **Classifier Bypass:** Passing explicit type parameter to `synthesizeBrief()` completely skips the 90% confidence gate. Safe because type is validated at parse time against SPRITE_TYPES enum.

3. **Queue-Layer Graceful Degradation:** Invalid types are silently omitted (not included in the optional field), allowing requests to still process via inference fallback. This is safer than rejecting the entire request.

4. **No Permanent Blocking:** Removed label-based blocking entirely. Transient errors (429s, timeouts, etc.) no longer permanently trap issues. Users can fix issues and restart sidecar to retry.

## Unresolved Issues

None. All prior code-review concerns from plan and code review stages have been resolved.

## Recommended Next Steps

1. Create PR with title: "feat: add optional --type to asset-request + type inference guard"
2. Merge with `gh pr merge --auto --squash` (squash-merge policy)
3. Monitor sidecar performance: asset-request issues should now process without low-confidence classifier blocks
4. If additional naming patterns emerge (e.g., new asset conventions), update `inferSpriteTypeFromName()` heuristics

## Notes

- Generated asset files are not committed (in .gitignore); they appear during sidecar runs
- Ledger is fully validated and includes all required review stages for 2🍎 complexity
- No breaking changes; optional type field is backward-compatible (legacy requests without type still process via inference)
- Branch is up-to-date with main; ready for immediate merge
