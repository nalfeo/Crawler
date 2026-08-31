# Goobers hosted backlog selection recovery

## Systems touched

agent-tooling, ci

## Apples

Estimated: 2🍎 — actual: 2🍎.

## Summary

- Made the hosted Actions wrapper select the oldest open, unassigned
  `goobers:approved` issue that is not already in review before starting a fresh
  Goobers run.
- Passed that issue through the existing recovery input path, avoiding the
  nested `backlog-query` invocation that cannot resolve the host instance from
  its isolated stage.
- Made an empty eligible backlog skip the Goobers run cleanly.
- Added workflow contract coverage for selection, exclusions, and the no-work
  guard.

## Files touched

- `.github/workflows/goobers-run.yml`
- `tests/unit/goobers-run-workflow.test.ts`
- `docs/knowledge/handoffs/2026-08-30-goobers-hosted-backlog-selection.md`

## Evidence

- Before: Actions run `33326068834`, Goobers run
  `e3014af2c4771f6eba396e8e40eb0b57`, failed in `query-backlog` with
  `provider_error: read instance.yaml: open instance.yaml: no such file or directory`.
- Issue `#3798` remained open, unassigned, and labeled `goobers:approved`.
- After: the hosted wrapper resolves an eligible issue number before
  `goobers run`, so the workflow uses its existing explicit-issue path rather
  than the failing fresh-backlog subprocess.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-workflow.test.ts`
- `npm run format:check -- --check .github/workflows/goobers-run.yml tests/unit/goobers-run-workflow.test.ts`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs`

## Unresolved issues

- The pinned Goobers binary still cannot resolve its instance root when
  `backlog-query` is nested inside a shell-script stage. Local daemon runs retain
  the existing command as a fallback; hosted runs no longer enter that path.

## Recommended next steps

- After this change lands, let the next scheduled run claim issue `#3798` and
  confirm that hosted progress advances beyond `query-backlog`.
