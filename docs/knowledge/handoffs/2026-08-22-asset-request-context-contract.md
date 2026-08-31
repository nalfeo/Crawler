# Handoff: Asset request context contract

## Systems touched: sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 3🍎. Actual: 3🍎. This is tooling/pipeline work and remains within the tooling-only complexity cap.

## Summary

- Added a shared request-context model derived from registered floor manifests and their enemy packs: floor ID/intensity, family, legal mob role, canonical floor/family design-language strings, and immutable request-local overrides.
- Made GitHub asset requests and the local Workflow Author surface the same user-authored capability set, including priority and requester metadata. GitHub-author identity remains authoritative where it exists.
- Added the sidecar capability endpoint and persisted local Author selections through synthesis into generated brief YAML and prompt addenda.
- Added a deterministic test that makes the static GitHub floor-ID form choices fail when they drift from the game-derived local capabilities.
- Fixed CI recovery so a linked issue already claimed by Goobers is cleared from pending restarts rather than retried indefinitely.

## Verification

- Focused workflow extension tests: 88 passing.
- Focused sprite context tests: 87 passing.
- CI recovery reconciliation regression tests: 159 passing, 18 known Windows skips.
- `npm run verify:fast` — passed (74 files, 1248 tests).
- Reloaded the workflow extension, restarted the sidecar, opened the real Workflow canvas, and confirmed its live state exposes Floor 1/Floor 2 capabilities and the Floor 2 family list.

## Observe before done

Before: local Author could only send name, brief, type, and footprint; floor/family/theme context and request metadata were unavailable despite GitHub-side support.

After: the real Author canvas receives live game-derived context capabilities; it provides floor intensity plus floor/family/role controls and request-local injection editors, with synthesis carrying the selected snapshot into the pipeline.

## Review

Plan review found and corrected the missing local numeric-floor parity path and added a deterministic GitHub-form drift check. Code review found and corrected the Goobers-owned pending-restart retry loop; the second pass was clean. The accompanying review ledger records the final independent grade.
