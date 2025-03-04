# Handoff: shock-baton PR merge recovery

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-workflow

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Recovered PR #1550 from `main` drift by merging `origin/main` into
`copilot/asset-request-shock-baton`. The only conflict was the generated
handoff index; regenerating `docs/knowledge/handoffs/INDEX.md` preserved the
branch's `shock-baton` handoff entry alongside the newer upstream handoffs.

## What changed

- Merged `origin/main` into `copilot/asset-request-shock-baton`.
- Resolved the lone conflict in `docs/knowledge/handoffs/INDEX.md` by
  rebuilding the generated index from the merged handoff set instead of
  hand-editing the section.

## Validation

- `npm run verify:fast` (pre-merge baseline)
- `npm run docs:index`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## CI investigation

- GitHub Actions check runs for PR #1550 on pre-merge head `8fc1709` were green;
  the active blocker was merge drift, not a failing required check.

## Observe before done

- Before: PR #1550 was blocked as merge-dirty against `main`.
- After: the branch contains the merged upstream handoff set plus the
  `shock-baton` brief/handoff, with the generated index rebuilt on top.

## Unresolved issues

- None. The next external step is for CI to rerun on the merge commit after the
  push.
