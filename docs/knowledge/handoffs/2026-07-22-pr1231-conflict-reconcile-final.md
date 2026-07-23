# Handoff: PR #1231 final merge-conflict reconciliation

## Date

2026-07-22

## Persona

Producer

## Systems touched

ci-policy, docs-tooling

## Apples

Estimated 3🍎, actual 2🍎.

## What changed

- Re-merged the latest `origin/main` (at `f3d120a81`) into `nalfeo-fix-bat-ranged-dodging` after a prior recovery merge (`2b863cbb`) was outpaced by new main commits, producing merge commit `12578fcb5`.
- Resolved the `.github/scripts/ci-recovery/reconcile.mjs` conflict by taking main's TOCTOU refactor: removed the stale `const reviewDecisionHeadSha = markerHeadSha;` local so the head-SHA guard reads `pr.head.sha` directly (matching main's comments that `markerHeadSha` must not be the baseline). Keeping HEAD's variable would resurrect the guarded bug and add an unused-variable lint error.
- Regenerated the generated `docs/knowledge/handoffs/INDEX.md` via `npm run docs:index` (union of main + branch handoffs) rather than hand-merging.
- Fixed a silent delete/add-dependent semantic conflict: my branch had deleted the (then-orphan) `src/shared/data/floor2-equipment-art.ts`, but main revived it as a live dependency of `src/shared/data/floor2-weapon-bases.ts` and `tests/unit/floor2-weapon-wave-a.test.ts`. Git's textual auto-merge kept the deletion (no markers) and broke typecheck; restored the file verbatim from `origin/main`.
- Added this session's 2🍎 tier-only review ledger at `docs/knowledge/review-ledgers/2026-07-22-pr1231-conflict-reconcile-final.review-ledger.json`.

## Observe before done

- Before: GitHub reported PR #1231 as `mergeStateStatus=DIRTY` / `mergeable=CONFLICTING` on head `7ea430fa7`; a local `origin/main` merge reproduced textual conflicts in `reconcile.mjs` + `INDEX.md` plus a silent semantic break (deleted `floor2-equipment-art.ts` with live main dependents) that failed `npm run verify:fast` typecheck.
- After: head `12578fcb5` is a clean two-parent merge on current `origin/main`; `gh pr view 1231` reports `mergeable=MERGEABLE`; `npm run verify:fast` passes (typecheck + lint + changed unit tests: 156 tests, plus physics/size/weight coverage checks all green); all 33 review threads remain `isResolved`; auto-merge armed (SQUASH).
- Real artifact: `npm run verify:fast` full green run + `gh pr view 1231 --json mergeable` (`MERGEABLE`). The primary gameplay fix (`src/game/ai/bt-ai-provider.ts` combat spacing during focused hunts + `planFocusedMeleeEngagement` alias) and the damage-source-attribution changes auto-merged cleanly and are preserved unchanged.

## Verification

- `npm run verify:fast` (full green; 156 changed-unit tests pass; size/weight/physics-defs coverage OK)
- `git merge-tree` preview to enumerate real conflicts before merging
- `npm run docs:index` (regenerated INDEX.md)
- `grep floor2-equipment-art` confirmed live dependents (`floor2-weapon-bases.ts`, `floor2-weapon-wave-a.test.ts`) — restore is correct, not dead code
- `gh pr view 1231 --json mergeable,mergeStateStatus` (`MERGEABLE`, BLOCKED only pending CI re-run)
- `gh api graphql reviewThreads` → `{total:33, unresolved:0}`

## Notes

- Operated as the assigned CI-recovery agent: `lease-acquire` correctly refuses ("owned by automation") because the `ci-owner-pr-1231` label is held by automation, which dispatched the recovery to `@copilot`. leaseId is null, so no competing shepherd holds a lease; the trusted CI-recovery reconciler (`CRAWLER_CI_PAT`) is authoritative and converges after a mergeable commit is pushed — no manual label mutation needed.
- Did not run `scripts/agent/lab-gate-check.sh` locally (Windows Git Bash slow; CI enforces it — per AGENTS.md).
- No asset or Azure mutations.
