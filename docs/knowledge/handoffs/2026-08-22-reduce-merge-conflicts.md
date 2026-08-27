# Session Handoff: Remove the package.json guard-test registry merge-conflict magnet

## Date

2026-08-22

## Persona

Velocity Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated / 3🍎 actual (tooling-only ceremony cap)

## What Was Done

Closed #3281 ("Reduce rate of merge conflicts — examine the last weeks work and
address the top areas where we saw merge conflicts").

**Evidence first.** Ran `npm run velocity:conflict-scan` over 14- and 7-day
windows on `origin/main` first-parent history (after `git fetch --unshallow`,
since the agent clone arrives 2-commit shallow). Overall same-day co-touch rate
was 7.8%. Top non-source hot spots:

| file                                | overlap events / touches  | already handled?                                                                      |
| ----------------------------------- | ------------------------- | ------------------------------------------------------------------------------------- |
| `docs/knowledge/handoffs/INDEX.md`  | 12 / 18                   | **yes** — `pr-preflight` guard denies committing it, and merge-train auto-resolves it |
| `package.json`                      | 9 / 15 (4 contended days) | **no**                                                                                |
| `docs/knowledge/agent-memory.jsonl` | 2 / 4                     | n/a (see Key Decisions)                                                               |

A background research agent independently confirmed ≥4 conflict-bearing PRs in
the Aug 15–22 window, with `package.json`/`package-lock.json` among the top real
conflict files.

**The fix.** `package.json`'s `test:guards` was a **1311-character single line**
hand-enumerating 161 `*.test.mjs` paths, edited 13 times since 2026-06-01 (3 in
the last 14 days). Two PRs each adding one guard test both rewrite that one line
→ guaranteed textual conflict. `test:sweep-viewer` (485 chars, 7 files) was the
same pattern, and `scripts/canvas-harness/README.md` step 5 _instructed_ every
new canvas author to append to it.

Replaced both with deterministic filesystem discovery:

- `scripts/agent/run-node-tests-lib.mjs` — pure lib: `TEST_GROUPS`,
  `discoverTests()`, `rootsForGroup()`, `chunkFiles()`, `runGroup()` with an
  injected `spawn` so it is unit-testable without running the real suites.
- `scripts/agent/run-node-tests.mjs` — thin CLI; anchors the repo root off
  `import.meta.url`, exits 2 on usage/config errors.
- `scripts/agent/run-node-tests-lib.test.mjs` — 10 regression tests.
- `package.json` — both scripts are now one short, stable line each.
- `scripts/canvas-harness/README.md` — step 5 now says tests are discovered
  automatically and explicitly says _not_ to edit `package.json`.

**Proof of no gate weakening.** `test:guards` is a blocking CI gate
(`.github/workflows/ci.yml` `check-format-and-labs`, plus `scripts/agent/verify.sh`).
Proved the discovered set is **exactly equal** to the previously enumerated 161
files (empty symmetric difference in both directions), then ran the real gate:
2725 tests pass (2722 pre-existing + 3 new chunking tests). `npm run verify:fast`
green.

## Key Decisions Made

- **Fail-closed discovery.** A configured root that matches zero test files
  **throws**. Bare `node --test <glob>` exits 0 on zero matches, so a silent
  typo or directory rename would otherwise turn a blocking gate into a no-op —
  the exact "defanged guard" failure mode the review contract warns about.
- **Explicit file args, not directory args.** Node 22's `node --test <dir>` uses
  Node's own default test-file patterns, which is a _different_ set than
  `*.test.mjs`; passing directories would silently change which tests run.
- **Deterministic chunking** (`chunkFiles` / `ARG_BUDGET_CHARS = 16000`,
  code-review finding). 161 paths is ~11KB of Windows' 32,767-char command-line
  limit — close enough that unbounded growth would eventually fail on Windows
  only. Batches are deterministic, every batch runs, and the first non-zero exit
  code is returned (never short-circuits and never masks a later failure).
- **`path.relative()` over `slice(root.length + 1)`** (code-review finding) —
  the arithmetic form breaks for filesystem-root repos and Windows drive-letter
  casing. Sorting uses plain codepoint comparison, not `localeCompare`, so
  batch composition is locale-independent.
- **Dropped a planned `.gitattributes merge=union` entry for
  `docs/knowledge/agent-memory.jsonl`** (blocking plan-review finding). That
  file looks append-only but is **not**:
  `scripts/agent/docs/promote-mistakes-lib.ts` `upsertEntity()` _replaces_ the
  `Session_Mistakes` line, so recent commits are all 1 insertion + 1 deletion.
  `merge=union` would silently duplicate the entity and drop observations —
  data corruption presented as a conflict fix.
- **Scoped to one magnet, not all of them.** Explicitly out of scope and flagged
  as follow-ups rather than silently expanded: `.github/workflows/deploy.yml`
  decomposition, `scripts/agent/perf/winrate-sweep.ts`, and re-opening #1682
  (shared `items.ts`/`equipmentDefs.ts`/`weaponDefs.ts` registries, previously
  closed `not_planned`).

## What's Next / Blockers

None blocking. Follow-up candidates, in descending evidence order:

1. `package-lock.json` still co-touches with `package.json`; it is machine-generated
   and could take a merge driver, but that needs its own evidence pass.
2. `.github/workflows/deploy.yml` appeared in real conflicts — likely
   decomposable into composite actions.
3. `src/game/ai/bt-ai-provider.ts` was the top **source** co-touch file (11/19).
   Worth checking whether its behavior-tree registration surface is a registry
   that could be derived the same way this one was.

## Retrospective

### Lessons Learned

- The repo already had strong anti-conflict machinery (`pr-preflight` guard,
  merge-train INDEX.md auto-resolution, `auto-rebase-prs.yml`, `sync:main`).
  The highest-value work was therefore finding the top _unhandled_ hot spot, not
  adding a fourth generic mechanism. Always check what's already defended first.
- `velocity:conflict-scan` is a **same-day co-touch proxy**, not a conflict
  count. Reconstructing real conflicts via `git merge-tree` over merged PRs was
  mostly stale-branch noise; pairing the proxy with a log/PR-comment mining pass
  gave a much more trustworthy ranking.
- A hand-maintained registry inside a single long line of a shared file is the
  worst possible conflict shape: every addition rewrites 100% of the line, so
  even two semantically-independent additions collide textually.

### Mistakes Made

- Edited `package.json` with a non-greedy regex on `"test:guards": ".*?"` — the
  escaped quotes inside the value corrupted the file. Recovered with
  `git checkout package.json`; use line-based replacement and re-validate by
  parsing the JSON.
- Assumed `agent-memory.jsonl` was append-only when drafting the plan. The
  separate-model plan review caught it. Verify append-only-ness by reading the
  _writer_, not by eyeballing the format.

### Opportunities for Future Improvement

- Consider a deterministic guard that fails when any `package.json` script value
  exceeds N characters or enumerates more than N file paths, so the next
  hand-maintained registry is caught at authoring time rather than after it has
  caused conflicts for two months.
