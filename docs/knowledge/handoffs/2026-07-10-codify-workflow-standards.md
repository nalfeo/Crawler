# Session Handoff: Codify broad-sweep + investigation workflow standards

## Date

2026-07-10

## Persona

Producer (workflow/policy tooling)

## Systems touched

ci-policy, agent-personas, docs-tooling

## Apples

4🍎 estimated, 4🍎 actual (🎯 exact)

## What Was Done

Codified two repo standards across top-level instructions, policy docs, and the sweep skill surface: (1) broad sweeps (>10 runs) should default to GitHub-backed workflow dispatch/CI runners instead of local compute, and (2) investigation/repro/debug sessions are process-light unless they are landing a merge-intent fix, in which case a separate implementation session/PR must run full process. Added a concrete workflow hook at `.github/workflows/weapon-sweep.yml` (`workflow_dispatch`) so large weapon sweeps have an explicit GitHub path. Updated `scripts/agent/docs/check-session-instructions.ts` to enforce mirrored wording between `AGENTS.md` and `.github/copilot-instructions.md` for these rules.

Observed in real artifact checks: before this session there was no dedicated `weapon-sweep.yml` dispatch workflow and no mirrored-rule enforcement for the two new standards; after the changes, the workflow exists and `check-session-instructions` validates mirrored presence.

## Key Decisions Made

- Defined "broad sweep" operationally as **more than 10 runs** to avoid ambiguous guidance.
- Kept local sweeps explicitly allowed for smoke checks (<=10 runs) and explicit human override, rather than hard-banning local execution.
- Encoded investigation-vs-implementation boundary in policy text instead of introducing new orchestration machinery.
- Added the GitHub workflow hook directly (`weapon-sweep.yml`) so guidance points to a concrete runnable path.

## What's Next / Blockers

- `npm run verify:fast` passed.
- `docs:check` ADR consistency blockers from ADRs 0003/0018/0052/0054/0055 were repaired in this same branch (commit `a2d20cb4`). No remaining docs:check blockers.
- ADR 0056 added in this branch to record the cross-system policy decision (addressing the two-system rule).

## Retrospective

### Lessons Learned

- Policy changes are stickier when mirrored in both top-level instruction files and enforced by a deterministic docs check.
- Converting "should" guidance into an explicit workflow file materially reduces ambiguity for future sessions.
- A small run-count threshold (>10) is enough to direct behavior without creating a complex classifier.

### Mistakes Made

- I attempted PR creation before adding a handoff and review ledger; the guard rejection made the missing artifacts explicit. Early signal was the preflight denial mentioning both `pr-preflight` and `pr-review-ledger`.
- I originally relied on `get_changes_overview` alone, which did not surface the untracked workflow file before commit; `git status` was the reliable source for final staging.

### Opportunities for Future Improvement

- Add a docs-tooling check that cross-links broad-sweep policy text with available `workflow_dispatch` sweep workflows so policy and workflow hooks cannot drift.
- Consider adding a small guide under `docs/guides/` showing standard `gh workflow run ...` invocations for common sweep types.
