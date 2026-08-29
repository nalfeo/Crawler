# Silent-revert follow-up acknowledgement (shared merges)

**Date:** 2026-08-29  
**Issue/PR:** nalfeo/Crawler#3853

## Systems touched

ci-policy

## What changed

- Added a `Merge-Discard-Ack-For: <merge-ish>` trailer so an intentional-discard
  acknowledgement can live on a **later** commit instead of on the merge commit
  itself. The paths still come from ordinary `Merge-Discard-Ack:` trailers in the
  same trailer block.
- `collectMergeInputs` now scans every commit in `base..head` (one batched
  `git log`) for such follow-up acks, resolves the referenced rev with
  `git rev-parse`, and unions the paths into that merge's `ackedPaths`.
- Extended the guard's remediation text to point at the non-destructive path.

## Why

`health-silent-reverts` previously only accepted an ack carried on the merge
commit. Setting one on an **already-pushed merge shared by sibling branches**
requires amending shared history — which desyncs the siblings. On
`nalfeo-ux-refresh-hud-inventory-shop` that made three legitimately superseded
discards (merge `67592f9f8`) permanently unackable from any descendant branch,
so `verify:fast` could not go green on any of them. Two earlier Copilot attempts
produced empty PRs because the literal remedy is not executable from a
`main`-based branch.

## Deliberately NOT weakened

- The ack is still **merge-scoped and path-scoped** — no global path allowlist
  (which the guard's own design notes forbid) and no age-based tolerance.
- A follow-up ack naming a merge outside `base..head` is ignored, not honoured.
- A follow-up ack listing a path the merge did not discard still trips the
  existing stale-ack error, so a bogus ack cannot look like coverage.

## Usage

From a branch that inherits the merge (no history rewriting):

```bash
git commit --allow-empty -m "chore: acknowledge superseded discards

Merge-Discard-Ack-For: 67592f9f8
Merge-Discard-Ack: .github/agents/ux-designer.agent.md -- superseded by the rewritten lineage-aware visual-review section
Merge-Discard-Ack: .github/extensions/screenshot-viewer/extension.mjs -- superseded by the reworked lineage pairing implementation
Merge-Discard-Ack: .github/extensions/screenshot-viewer/renderer.mjs -- superseded by the reworked lineage pairing implementation"
```

## Verification

- `npx vitest run tests/unit/silent-reverts-guard.test.ts` — 66 passed
  (3 new real-git CLI cases + 3 new parser cases).
- Mutation check: deleting the follow-up-ack union from `collectMergeInputs`
  fails 2 of the new tests, so they are not tautological.
- `npm run typecheck`, `npx eslint`, `npx prettier --check` on the touched files
  — clean.
- `npm run check:silent-reverts` in this sandbox reports the shallow-clone
  fail-closed error (the clone has no merge history); the synthetic-repo CLI
  tests cover the real plumbing.

## Apples

Estimated 2🍎; tooling-only change to one guard plus its regression tests
(complexity policy caps tooling-only work at 3🍎, and 1–2🍎 needs no review
ledger).
