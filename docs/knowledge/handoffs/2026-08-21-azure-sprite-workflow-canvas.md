# Handoff: Azure sprite workflow canvas

## Systems touched: sprite-workflow, sprite-pipeline, devtools

## Apples

Estimated: 4🍎 — rescored: 3🍎 — actual: 3🍎. This tooling-only canvas is a thin operator adapter over the canonical sidecar authoring lifecycle, within the repository's 3-apple tooling cap.

## Summary

- Added the Author tab for canonical one-line request synthesis, editable draft-brief selection, promotion, Azure queue generation, post-process, judge, approval, and pointer-only rewind controls.
- Persisted the full shared 13-stage queue contract with field-level ETag retry merging so canvas writes preserve DevTools fields and concurrent same-item updates.
- Added an explicit, guarded `Refresh Azure workflow` control and polling that refreshes external Azure completions without replacing the active run selection or tearing down the editor unless state changed.
- Kept Azure worker consumers out of the canvas. The full author request text, including direction/resolution requirements, is passed unchanged to the existing synthesis endpoint.
- Unified the workflow around **Backlog → Briefs → Sprites**, with Backlog first, Brief generation and request editing on Briefs, and candidate generation/review on Sprites.
- Added editable full-template previewing that exposes the complete Crawler, floor, family, role, and sprite-category design-language injections before synthesis.
- Added canonical design language for all nine sprite categories. The global contract now names the classic RPG 3/4 orthographic perspective; enemy defaults specify the screen-right orthographic turn while explicit facing requests override direction without weakening orthographic construction.
- Added deterministic previews of the exact approved reference sprites generation would currently attach. Preview and generation now share one selector, including quality gates, dislike filtering, concept collapse, seeded selection, safe-path checks, and on-disk file checks.
- Prompt-affecting request edits now invalidate stale synthesized candidates and return the request to Draft; metadata-only edits preserve downstream state.

## Verification

- `node --test .github/extensions/workflow/tests/authoring-state.test.mjs .github/extensions/workflow/tests/sidecar-client.test.mjs .github/extensions/workflow/tests/renderer.test.mjs .github/extensions/workflow/tests/extension-security-guards.test.mjs` — 78 passing.
- `npm run verify:fast` — passed.
- Reloaded the workflow extension, opened the canvas, fetched durable workflow state, and verified the served Author UI includes Azure refresh and generation controls.
- `node --test .github/extensions/workflow/tests/renderer.test.mjs .github/extensions/workflow/tests/authoring-state.test.mjs .github/extensions/workflow/tests/sidecar-client.test.mjs .github/extensions/workflow/tests/request-filter.test.mjs` — 108 passing.
- `npx vitest run tests/unit/sprites/asset-request-context.test.ts tests/unit/sprites/azure-chat-synth.test.ts tests/unit/sprites/build-prompt.test.ts tests/integration/generate-one.test.ts` — 97 passing.
- Final `npm run verify:fast` — 79 files / 1,293 tests passing, plus all data-contract, integrity, and coverage checks.
- Live Workflow canvas observation confirmed mixed-case and kebab names resolve the same three deterministic references, reference PNGs load, custom category text survives type switching, and unsaved composer values survive full-template modal rerenders.
- Final lifecycle hardening: all Workflow extension tests passed; 137 focused asset-context/sidecar tests passed; `npm run typecheck` passed.

## Observe before done

Before: the canvas exposed browsing/review and approval only; operators could not author a one-line request or visibly refresh Azure workflow state.

After: the real Workflow canvas serves the Author tab with the complete sidecar-backed lifecycle and a visible `Refresh Azure workflow` control.

After the workflow/UX expansion: the real Workflow canvas serves the unified Backlog → Briefs → Sprites flow. The Briefs composer exposes the complete editable synthesis template and current approved reference examples; operators can move backward to edit requests, while prompt edits deterministically invalidate stale synthesis output.

## Review

The category/reference expansion received two final code-review rounds. Round 1 found two state/blank-name issues; round 2 found four candidate-invalidation, normalization, rerender-state, and contradictory-prompt issues. All six were fixed. A final live pass then caught and fixed the composer category-draft switching regression and the incorrectly scoped draft helpers. Independent grading found and drove fixes for destructive no-op edits, ambiguous template parsing, resolved-path containment, Floor 4 capability parity, nested tests, hidden edit failures, unreadable-reference races, and optional context shape drift. The final independent grade at `bd827aa0` passed cleanly with no findings and scores of 5/4/5/5/5. See `docs/knowledge/review-ledgers/2026-08-21-azure-sprite-workflow.review-ledger.json`.
