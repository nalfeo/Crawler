# Session Handoff: Guard headless floor-registry contamination

## Date

2026-08-01

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, mapgen

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact — a narrow headless-runner/floor-registry guard plus focused regressions)

## What Was Done

- Traced the in-process contamination risk to the module-level floor registry used by headless setup.
- Added built-in manifest reset/inspection helpers in `src/shared/floor-registry.ts`, backed by cloned shipped snapshots so direct in-place mutations are detectable and reversible.
- Added a `runHeadless` startup guard that throws immediately when built-in floor manifests no longer match shipped defaults, forcing contaminated in-process batches to fail loudly instead of silently producing bad measurements.
- Updated floor-registry and Floor 2 scenario tests to use the shared reset helper.
- Added a focused headless regression that mutates a built-in manifest in-process and verifies `runHeadless` rejects it with an actionable error.
- Fixed an unrelated strict-null typecheck failure in `tests/unit/sprites/asset-request.test.ts` (`match?.[1]?.trim() ?? ''`) so `verify:fast` stays green on this branch.

## Key Decisions Made

- Chose **fail-loud guardrails** over a broader automatic reset inside `runHeadless`. That keeps intentionally registered custom floors working, while still protecting measurement integrity for the shipped `floor1`/`floor2` manifests.
- Stored shipped manifest **snapshots as clones**, not shared references, so direct mutation of `getFloorManifest('floor1'|'floor2')` is detectable and resettable.
- Limited the guard to **built-in floors only**; custom registered floors are preserved across resets because they are not the contamination source called out in issue #2590.

## What's Next / Blockers

- I attempted to post the required pre-code plan comment to issue #2590, but this session's GitHub write path returned `HTTP 403: Blocked by DNS monitoring proxy` for issue-comment API calls. The exact plan text should be posted from a session with issue-comment write access before PR publication if that requirement must remain strict.
- No code blocker remains; targeted unit/headless tests passed and `npm run verify:fast` was rerun after the final edits.

## Retrospective

### Lessons Learned

- The important contamination case is not only `registerFloorManifest(...)`; direct mutation of the manifest returned by `getFloorManifest(...)` must also be guarded, so immutable snapshots matter more than registry-entry identity.

### Mistakes Made

- The first floor-registry guard compared against live built-in manifest references, which would have missed direct in-place mutation. Converting the defaults to cloned snapshots fixed that hole before final validation.

### Opportunities for Future Improvement

- If future harnesses need safe per-run manifest overrides for built-in floors, add an explicit scoped override/disposer API so callers can opt into temporary mutations without relying on process isolation.
