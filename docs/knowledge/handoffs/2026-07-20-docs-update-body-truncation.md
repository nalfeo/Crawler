# Handoff: fix docs-update CI — aggregate report body truncation

**Date:** 2026-07-20  
**Session slug:** docs-update-body-truncation  
**Branch:** copilot/fix-docs-update-loop  
**PR:** closes #1743

## Summary

Fixed a recurring `Docs Update Loop` CI failure where the workflow tried to create a
GitHub issue with a body that exceeded the 65 536-character limit.

**Root cause:** `build-system-index.ts` emits one `warn` per handoff that declares an
unknown system slug. With 773 handoffs currently in the repo, many of which use slugs
not yet registered in `docs/systems/README.md`, the script was generating ~97 KB of JSON
findings. `aggregate-report.ts` serialised all of these into a single Markdown body of
~72 KB — well beyond GitHub's 65 536-character issue body limit — causing the
`github.rest.issues.create` call to reject with HTTP 422 Validation Failed.

**Fix:** Added a `MAX_BODY_CHARS = GITHUB_BODY_LIMIT - METADATA_OVERHEAD` cap (65 136
characters) to `scripts/agent/shared/aggregate-report.ts`. When the generated body would
exceed the cap, it is sliced and a truncation notice appended that cites the total finding
count and links to the full workflow run for the untruncated output.

## Files Touched

- `scripts/agent/shared/aggregate-report.ts` — added constants and truncation logic

## Verification Run

- Simulated CI report generation with `build-system-index.ts` + `lint-handoff.ts` outputs → confirmed output = 65 136 JS chars (65 268 UTF-8 bytes), well within GitHub's limit.
- `npm run verify:fast` → 90 test files, 1297 tests, all pass.
- `parallel_validation` → code review clean, CodeQL trivial skip.

## Unresolved Issues

- `build-system-index.ts` emits per-handoff warnings for ~456 findings total; these
  correctly surface in the truncated issue with a link to the full workflow log.
  Long-term, registering the missing system slugs in `docs/systems/README.md` would
  reduce noise, but that is advisory work for a separate session.

## Recommended Next Steps

- Register frequently-used-but-unknown slugs (e.g. `equipment`, `world`, `rendering`,
  `ci`, `set-pieces`, `floor1-scenario`, `enemy-telegraph`, `quest-waypoints`) in
  `docs/systems/README.md` to reduce the warning flood and keep future reports un-truncated.

## Systems touched

ci-infra

## Retrospective

### Lessons Learned

The truncation fix is defensive: any future explosion in findings will be handled
gracefully instead of failing the workflow. The root cause (unregistered slugs) is
separately addressable without urgency.

### Mistakes Made

None — diagnosis was direct from the CI job logs.

### Opportunities for Future Improvement

Cap findings-per-script in `aggregate-report.ts` rather than a raw character truncation,
so each section retains its header and summary count even in a large report. That would
be a more structured alternative to a hard slice.
