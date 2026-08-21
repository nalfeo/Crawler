# Handoff: Azure sprite workflow canvas

## Systems touched: sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 4🍎 — actual: 4🍎. Extended the existing Workflow canvas as a thin operator adapter over the canonical sidecar authoring lifecycle.

## Summary

- Added the Author tab for canonical one-line request synthesis, editable draft-brief selection, promotion, Azure queue generation, post-process, judge, approval, and pointer-only rewind controls.
- Persisted the full shared 13-stage queue contract with field-level ETag retry merging so canvas writes preserve DevTools fields and concurrent same-item updates.
- Added an explicit, guarded `Refresh Azure workflow` control and polling that refreshes external Azure completions without replacing the active run selection or tearing down the editor unless state changed.
- Kept Azure worker consumers out of the canvas. The full author request text, including direction/resolution requirements, is passed unchanged to the existing synthesis endpoint.

## Verification

- `node --test .github/extensions/workflow/tests/authoring-state.test.mjs .github/extensions/workflow/tests/sidecar-client.test.mjs .github/extensions/workflow/tests/renderer.test.mjs .github/extensions/workflow/tests/extension-security-guards.test.mjs` — 78 passing.
- `npm run verify:fast` — passed.
- Reloaded the workflow extension, opened the canvas, fetched durable workflow state, and verified the served Author UI includes Azure refresh and generation controls.

## Observe before done

Before: the canvas exposed browsing/review and approval only; operators could not author a one-line request or visibly refresh Azure workflow state.

After: the real Workflow canvas serves the Author tab with the complete sidecar-backed lifecycle and a visible `Refresh Azure workflow` control.

## Follow-up

The independent-grade command must be run against this bounded handoff commit using `--base HEAD~`: this worktree's local `main` merge-base spans 3,147 unrelated historical files and exceeds the grader packet limit.
