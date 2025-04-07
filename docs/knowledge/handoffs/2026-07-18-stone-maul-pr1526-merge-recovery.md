# Handoff: Recover stone-maul PR merge conflict

## Date

2026-07-18

## Persona

Producer

## Systems touched

sprite-workflow

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1526 from a merge-drift conflict against `origin/main`. The
branch now carries a true merge commit and resolves both add/add conflicts by
keeping `main`'s canonical `stone-maul` brief and original `#1306` handoff,
because this PR's `#1431` request was later marked a duplicate.

## What changed

- Merged `origin/main` into `copilot/asset-request-stone-maul`.
- Resolved `briefs/weapons/stone-maul.yaml` to the canonical `main` version,
  preserving `floor: 2` and the current approved variation seeds.
- Resolved `docs/knowledge/handoffs/2026-07-18-stone-maul.md` to the original
  `#1306` handoff already present on `main`, avoiding a duplicate handoff body
  for the later duplicate issue.
- Confirmed there are no actionable open review threads on the PR head via a
  separate review agent.

## Validation

- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## CI investigation

- GitHub reported PR #1526 as `mergeable_state: dirty` before the merge.
- Recent branch checks already showed the prior PR-ready/reviewer guard was
  green; the active blocker on this recovery pass was merge drift only.

## Observe before done

- Before: PR #1526 conflicted with `main` on the duplicate `stone-maul` brief
  and handoff paths.
- After: the branch contains a clean merge commit with no unresolved conflicts;
  the next external step is CI rerunning on the pushed merge head.

## Unresolved issues

- Await the post-push GitHub checks on the merge commit.
