# Session Handoff: Extend Sweep Results Viewer for AI Sweep Eval

## Date

2026-07-17

## Persona

Producer → Feature Engineer (canvas extension work)

## Systems touched

ci-policy, agent-memory

## Apples

3🍎 estimated, 3🍎 actual (exact). Full JSON in docs/knowledge/metrics/apples/2026-07-17-ai-sweep-viewer.json.

## What Was Done

Extended the Sweep Results Viewer Copilot canvas extension (`.github/extensions/sweep-results-viewer/`) to support AI Sweep Eval (`ai-sweep.yml`) runs alongside the existing weapon-sweep runs. Closes issue #1245.

**Core changes:**

- `lib/cloud-results.mjs`: Added `parseAiSweepJobPhases(jobs)` (classifies jobs by phase regex), `isLeaderboardArtifact(artifact)`, `aiSweepWarning({run, jobPhases, hasLeaderboard, expiredArtifactCount})`.
- `lib/github-client.mjs`: Added `listAiSweepRuns`, `listAllSweepRuns` (via `mergeSweepRunResults` pure helper — extracted for testability), `loadAiSweepRun` (run + jobs + leaderboard artifact in parallel).
- `lib/state-helpers.mjs`: `stabilizeTerminalSnapshot` now accepts optional `isComplete(snapshot)` callback with a weapon-sweep `defaultIsComplete` that uses optional chaining. AI sweep path passes its own `isComplete` (checks `leaderboardData` arrival).
- `extension.mjs`: Dual workflow-type dispatch in `refreshCloudState`; `jobPhases` state field; `workflowType` propagated through `safeRun` → `stateSnapshot` → renderer; `listAllSweepRuns` for both `switchToCloudRun` and `initializeCloud`; `summaryPayload` handles both types; `runId` deep-link description and canvas actions updated.
- `renderer.mjs`: Dynamic `<h1 id="page-title">` updated per workflow type; `[AI]`/`[W]` run selector prefixes; live phase card grid (2×2); `renderLeaderboardTable(rows, heading)` extracted — renders both `byComposite` and `byLexicographic` when `winnersDiverge`; incumbent row styling and flip delta coloring.
- 41 tests (7 new): `mergeSweepRunResults` error paths, AI stabilization `isComplete` callback, expired leaderboard warning.
- `AGENTS.md`: Rule #17 + Quick Start bullet requiring Sweep Results Viewer deep links whenever a sweep is discussed.

Not a runtime source change (canvas extension only). No live game observation required.

## Key Decisions Made

1. **`workflowType` tag at the list site, not in `normalizeRun`**: `normalizeRun` is a pure shape-normalizer; it doesn't know which workflow it's called from. Each list function spreads `{ workflowType: '...' }` onto the normalized result. This keeps `normalizeRun` reusable.

2. **`mergeSweepRunResults` extracted as a pure sync helper**: `listAllSweepRuns` is hard to unit-test (requires `gh` CLI). Extracting the combining logic into `mergeSweepRunResults` lets the error-propagation behavior be verified without mocking the CLI.

3. **`isComplete` callback on `stabilizeTerminalSnapshot`**: Rather than branching inside `stabilizeTerminalSnapshot` by workflow type, a callback keeps the helper generic. The weapon-sweep default uses optional chaining so it doesn't crash on AI sweep snapshots even if called without a callback.

4. **Render both leaderboard orderings when `winnersDiverge`**: The warning "check both orderings" is only actionable if both are shown. The shared `renderLeaderboardTable` helper renders each with a distinct heading.

5. **`Promise.allSettled` with partial-failure surfacing**: One workflow failing should not hide the other's runs. If both fail AND combined is empty, the weapon-sweep error (primary) is surfaced. If only one fails and the other has runs, those runs are returned without error.

## What's Next / Blockers

- The `canvasOpen` return could be extended with a `description` field that includes the `runId` value when a deep link resolves, so the canvas title bar shows the specific run name.
- No known blockers; CI gate guards the extension on `check-format-and-labs`.

## Retrospective

### Lessons Learned

- The code reviewer correctly identified that plan-review fixes were in uncommitted working-tree changes and not in the reviewed HEAD commit. Always commit plan-review fixes before running the code-review round, so the reviewer sees the actual final state.
- `stabilizeTerminalSnapshot` had deeply implicit weapon-sweep assumptions (bare `.length` on `expectedWeapons`/`aggregateOutputs`). Any new run type calling it would crash. The optional-callback approach prevents future regression.
- Extracting `mergeSweepRunResults` as a pure sync helper cost 10 extra lines but enabled 5 unit tests for the 4 error-propagation cases — worth it.

### Mistakes Made

- Ran code review (round 1) before committing the plan-review fixes. The reviewer identified all 4 issues as present in HEAD, which was accurate — they were only in the working tree. This was confusing and caused a review round that effectively replayed the plan-review findings. Commit first, review second.

### Opportunities for Future Improvement

- Partial AI sweep artifacts (`search-<combo>`, `validate-<combo>`) are not downloaded — live state comes from jobs list. A future session could download these for richer per-combo detail before the leaderboard is ready.
- The viewer could add a copy-to-clipboard button for the deep link URL on the run status card, making it easier for agents to paste app-native links into conversation.
