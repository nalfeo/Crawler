# 2026-06-05 — Chronicle Telemetry System

## Summary

Designed and implemented the first phase of a telemetry feedback loop for the Crawler agent-OS. The system uses Chronicle (`session_store_sql`) as a read-only telemetry backend to enable evidence-based pruning and enhancement of guards, instructions, and memory docs.

## What Ships

### Guard Telemetry Emission

- New `lib/telemetry.mjs` — structured JSON emission helper
- Modified `lib/dispatcher.mjs` — emits `[guard-telemetry]` log on every guard decision (deny, ask, allow, skip, bypass, crash)
- 4 new tests in `tests/telemetry.test.mjs`; all 119 extension tests pass

### Daily Analysis Workflow

- Copilot CLI scheduled workflow (daily at 08:00, skips if no new sessions)
- Queries chronicle for guard fire-rate, memory freshness, instruction effectiveness
- Files a GitHub issue with labels `agent-os` + `telemetry` containing the report
- Workflow submitted for user review via save_workflow dialog

### Policy & Architecture Docs

- `docs/agent-os/policies/telemetry-policy.md` — thresholds, cadence, governance
- `docs/knowledge/adr/0004-chronicle-telemetry.md` — decision record

## Verification

- `node --test ".github/extensions/copilot-guards/tests/*.test.mjs"` → 119 pass
- Extension structure reviewed — telemetry calls are fire-and-forget, never block the guard pipeline

## Open Question

Does `session.log()` output actually land in chronicle's `events` table in a queryable column? The guard-telemetry events will start emitting immediately, but we need to verify they're queryable after 1-2 sessions. If not, fallback is a local `.jsonl` append file.

## Deferred

- **Pruning automation** — needs 7+ days of telemetry data before scripts can be built
- **Enhancement automation** — same; needs data to identify promotion candidates
- Both are tracked as blocked todos in this session

## Files Touched

- `.github/extensions/copilot-guards/lib/telemetry.mjs` (new)
- `.github/extensions/copilot-guards/lib/dispatcher.mjs` (modified — telemetry emission)
- `.github/extensions/copilot-guards/tests/telemetry.test.mjs` (new)
- `docs/agent-os/policies/telemetry-policy.md` (new)
- `docs/knowledge/adr/0004-chronicle-telemetry.md` (new)
- `docs/knowledge/handoffs/2026-06-05-chronicle-telemetry.md` (this file)

## Next Agent Steps

1. After 1-2 sessions with guards active, query chronicle for `[guard-telemetry]` events to verify they're queryable
2. If not queryable, implement local `.jsonl` fallback in `telemetry.mjs`
3. After 7 days of data, build pruning/enhancement automation scripts
4. Review first daily telemetry issue for threshold tuning
