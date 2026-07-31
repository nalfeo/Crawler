# 2026-07-31 — PR #2414 recovery (round 2)

## Systems touched

ci, sprites

## Summary

- Cleared the reported PR merge-conflict blocker by syncing branch `assets/batch-20260731-015729` with latest `main`.
- Removed unintended drift introduced by prior recovery commits so the branch tree now matches `main`.
- Confirmed the checked-in asset key/path wiring remains valid in runtime: `openVertical: 'tile-door-open-side-v1-var-0'` maps to `public/assets/generated/tile-door-open-side-v1-var-0.png` via generated manifest entry metadata.

## Files touched

- `docs/knowledge/handoffs/2026-07-31-pr2414-recovery-round2.md`

## Verification run

- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` (pending rerun after this handoff)
- GitHub Actions MCP: `list_workflow_runs` + `get_job_logs` (no failed jobs reported)
- PNG integrity check (`tile-door-open-side-v1-var-0.png`): exists, dimensions `83x128`, non-empty IDAT payload

## Unresolved issues

- None at handoff time.

## Recommended next steps

- Re-run `npm run verify:pr-prereqs` now that this handoff exists, then arm auto-merge.
