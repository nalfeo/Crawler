# Handoff: brief-batch consolidation command and queue-commit brief bundling

**Date:** 2026-08-01
**Session slug:** brief-batch-consolidation
**Apple estimate:** 3🍎 (tooling-only cap)
**PR:** TBD (opens after this handoff)

## Problem

As of 2026-07-31, 22 open PRs each added a single `briefs/enemies/*.yaml` file as
individual Copilot PRs, causing:
- ~22× CI churn per brief
- Merge conflicts in shared test fixtures
- Extra triage work to batch-merge

Related: nalfeo/Crawler#2592 (the manual batch that consolidated the backlog)

## Systems touched

sprites-pipeline, asset-request-publisher, queue-commit, ci-classify

## What changed

### Part 1 — `sprites:brief-batch` CLI command (analogous to `sprites:asset-pr`)

New file **`scripts/sprites/brief-batch.ts`** (pure planner + IO-injected executor):
- `parseBriefOnlyPRs(prsJson, diffsByHeadRef)` — identifies PRs where every
  changed file is under `briefs/`, using three-dot diffs vs `origin/main` so
  GitHub's "Files changed" semantics are matched exactly.
- `planBriefBatch({prs, now, baseBranch?, slug?})` — builds the branch name
  (`batch/briefs-<stamp>`), deduplicates paths (last-writer-wins), produces PR
  body listing source PRs and close instructions.
- `runBriefBatchConsolidation(repoRoot, deps, options)` — full executor: lists
  open PRs via `gh`, fetches each branch (skips gracefully on 404), diffs vs
  main, checks out each brief file explicitly by path (no wildcard), commits,
  pushes, and opens ONE batch PR. Returns `null` when there's nothing to batch.

New file **`scripts/sprites/brief-batch-cli.ts`** — CLI wrapper:
- Argparse (`--base`, `--remote`, `--slug`), real fs+exec deps, prints source PR
  close commands on success.

**`package.json`** — added `"sprites:brief-batch": "tsx scripts/sprites/brief-batch-cli.ts"`.

### Part 2 — queue-commit pipeline fix (bundle briefs alongside art)

**`scripts/sprites/queue-commit.ts`**:
- Added `'invalid-brief-path'` to `QueueCommitError` kind union.
- Added optional `copyBriefFiles` dep to `QueueCommitDeps` (IO-free core stays
  testable; implementation injected at runtime).
- Added `briefs?: readonly string[]` to `QueueCommitOptions`.
- Added `assertSafeBriefPaths()` — validates no absolute paths, no `..`
  traversal, each path must start with `briefs/`.
- **B1 fix**: brief copy + `git add -- briefs/` is staged *before* the
  `diff --cached --quiet` no-op guard, so a commit that updates only a brief
  (with identical art bytes already on the queue) is not silently swallowed.
- **B2 fix**: orphan-reset path now restores `briefs/` from the queue tip after
  `reset --hard mainRef`, so previously queued briefs are not discarded.
- Empty-input guard updated: `assets.length === 0 && briefs.length === 0`.

**`scripts/sprites/queue-commit-runtime.ts`**:
- `copyBriefFiles` implementation: `copyFileSync` + `mkdirSync` per brief path.

**`scripts/sprites/asset-request-publisher.ts`**:
- Passes `briefs: [item.checkpoint.details.promotedBriefPath]` to
  `runQueueCommit`, so the brief YAML is bundled with its art in the same queue
  commit.

### Part 3 — CI classifier and reconcile guard

**`scripts/agent/ci/detect-art-only.sh`**:
- `briefs/*` added to `art_only` and `gameplay_safe` case arms.
- NOT added to `sprites_only` or `sprites_touched` (brief files are design data,
  not sprites).

**`scripts/sprites/checkin.ts`**:
- `'briefs'` added to `ART_SURFACE_ALLOWLIST` so the reconcile guard accepts
  brief paths on the queue branch.

### Part 4 — Tests

**`tests/unit/sprites/brief-batch.test.ts`** (NEW ~280 lines):
- `parseBriefOnlyPRs`: malformed JSON, brief-only filter, mixed-file filter,
  empty diff, multi-path, no-headRef.
- `planBriefBatch`: empty-input throw, branch naming, timestamp slug, dedup,
  path sort, source PRs, PR body.
- `runBriefBatchConsolidation` (fake exec): null on empty list, null on no
  brief-only PRs, skip missing branches, full happy path (worktree, checkout,
  add, commit, push, pr create), three-dot diff shape.

**`tests/unit/detect-change-scope.test.ts`**:
- Two new test cases: `briefs/`-only (art_only=true, gameplay_safe=true) and
  `briefs/` + art bundled together (same).

## Key decisions

| Decision | Rationale |
|---|---|
| Three-dot diff (`...`) for brief-only classification | Matches GitHub "Files changed" semantics |
| Explicit per-path `git checkout` (not `briefs/**` wildcard) | Avoids globbing bugs when only some briefs should be included |
| No auto-close of source PRs | Risk of stranded work; PR body lists close instructions instead |
| `copyBriefFiles` as injected dep | Keeps `queue-commit.ts` IO-free for testability |
| B1 before noop guard | Prevents briefs silently disappearing when art bytes are identical |
| B2 orphan-reset brief restore | Prevents losing previously-queued briefs on reset |

## Review

- Plan review: rubber-duck (claude-opus-4.8) — approved with 6 concerns (B1, B2, N1-N2, N4, S1), all fixed before implementation
- Code review: claude-opus-4.8 (see ledger)
- Review ledger: `docs/knowledge/review-ledgers/2026-08-01-brief-batch-consolidation.review-ledger.json`

## How to use `sprites:brief-batch`

```sh
# Consolidate all open brief-only PRs into one batch PR:
npm run sprites:brief-batch

# Specify custom base or remote:
npm run sprites:brief-batch -- --base main --remote origin

# Override the branch slug (still pushes and opens a real PR):
npm run sprites:brief-batch -- --slug my-test-batch
```

After the batch PR merges, the output lists `gh pr close <N>` commands for each
source PR.
