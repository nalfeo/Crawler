# Session Handoff: Fix scoped-lint deleted/renamed-file bug in verify-fast.sh (PR #397 takeover)

## Date

2026-06-27

## Persona(s) adopted

**DevOps Engineer** — the change is confined to `scripts/agent/verify-fast.sh`
(inner-loop tooling). Pure build/test throughput robustness work, no game-layer
code. Matches the routing matrix mapping `scripts/agent/*` → DevOps Engineer.

## Routing verdict

✅ Right persona — single tooling script; no other layer touched.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — one surgical script edit + a reproduction test, plus a rebase
that needed re-stacking after a concurrent force-push of the branch. No
architectural change, no new deps.

Hello kitties: 2/5 = 0.40 🎀

## Context

Took over PR #397 (`perf: speed up local dev loop`) to drive it to a clean
squash-merge. The original session is gone. CI was all-green and the branch only
needed a rebase, but one unresolved review thread blocked merge
(`required_conversation_resolution`).

## The Bug (reviewer-flagged, real)

`copilot-pull-request-reviewer` on `scripts/agent/verify-fast.sh:35`: the
scoped-lint changed-file union was built from `git diff --name-only` (merge-base,
working-tree, and `--cached`), which **reports deleted and renamed-away `.ts`
paths**. Those paths still passed the `grep` filter but no longer exist on disk.
ESLint v10 errors when handed an explicit path that doesn't exist, so any branch
that deletes/renames a tracked `.ts` file would break `verify:fast` — the most
frequently-run command — for the life of the branch.

## The Fix

Two defenses in `verify-fast.sh`:

1. Added `--diff-filter=ACMR` to the three `git diff --name-only` calls. This
   drops deletions (`D`) at the source and reports renames at their **new** path,
   so a vanished path is never collected in the first place.
2. Guarded the collection loop with `[ -f "$f" ]` (belt-and-suspenders) so even
   if a non-existent path were ever produced, it can never be passed to ESLint.

The speedup is unchanged — only which paths populate the changed-file list.

## Verification (observe-before-done)

- **Reproduced the bug then confirmed the fix:** staged a working-tree deletion
  of a real tracked file (`src/bootstrap/floor-game-config.ts`). Under the **old**
  logic the deleted path was present in the collected list (would break ESLint);
  under the **new** logic it was excluded — `PASS`. Working tree restored clean.
- `bash scripts/agent/verify-fast.sh` end-to-end: ✅ passed (typecheck OK, scoped
  lint reported "No changed TS files to lint" for this `.sh`-only change set, unit
  no-op).
- Scoped ESLint smoke test on a real existing `.ts` file: `ESLINT-PATH-OK`.
- `node_modules` was absent in this fresh worktree; ran `npm ci` (465 packages)
  before validating.

## Branch State

- Branch: `nalfeo-speed-up-local-dev`
- Rebased onto latest `origin/main` (`065c9120`). A concurrent force-push had
  moved the remote branch to `80a62114` (the PR commit re-rebased onto newer
  main, incl. #396); re-stacked the fix on top via
  `git rebase --onto origin/nalfeo-speed-up-local-dev 15e5ef38`.
- Addressing commit: `5be098e0` — `fix(tooling): exclude deleted/renamed files
from scoped eslint in verify-fast.sh`. Pushed (`--force-with-lease`).
- Review thread `PRRT_kwDOSvo2Ms6Msf48` replied to with `✅ Addressed in
5be098e0: …` and resolved via GraphQL `resolveReviewThread`
  (`isResolved: true`).
- Auto-merge armed: `gh pr merge 397 --auto --squash`.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` absent this session — N/A.

## What's Next

- The original handoff (`2026-06-27-speed-up-local-dev.md`) lists CPU-aware
  follow-ups (parallelize `verify.sh` test projects, shared dependency store for
  worktrees, unify ESLint cache locations). Those remain open and are unaffected
  by this fix.

## Key Decisions

- Used both `--diff-filter=ACMR` **and** the `[ -f ]` existence guard rather than
  picking one: the diff-filter avoids even considering deletions and maps renames
  to the new path; the existence guard is a cheap, total guarantee that ESLint
  only ever sees real files regardless of git rename-detection config.
