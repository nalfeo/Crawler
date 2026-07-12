# 2026-07-11 - Sprite editor UX refinement

## Systems touched

sprite-pipeline, sprite-workflow, devtools, ci-policy

## Summary

- Replaced the Sprite Editor's monolithic wrapping toolbar with a compact app bar, persistent quick actions, named tool rail, and contextual settings panel.
- Kept every edit action visible and reachable within two clicks, with hotkeys for tool selection, a previous-tool toggle, focus restoration, and explicit active/disabled states.
- Added persistent side-by-side Last Saved/After canvases. Last Saved remains fixed through edits, Undo, and Redo, then refreshes only after Save, Revert, or loading another sprite.
- Preserved canvas pan position across rerenders and made high-zoom comparison content expand the shared scroll viewport.
- Fixed stale form state bleeding into newly loaded sprites. Like, Dislike, metadata, and annotation values now remain scoped to the sprite being edited.
- Added mutually exclusive Like and Dislike reactions. Dislikes are stored alongside feedback so later reprocessing and regeneration workflows can consume the signal.
- Added a status-only live region, visible labels, keyboard focus treatment, measured visual-review regions, and responsive desktop/narrow layouts.

## Observe before done

- Before: the live editor rendered every control in one undifferentiated toolbar wrapping across three rows, with Save/Revert mixed into cleanup controls and no stable tool hierarchy.
- After: the live `sprite-editor` canvas uses a Photoshop/Canva-style editor shell with a persistent app bar, six named tools, contextual options, and balanced 438 px Last Saved/After panes at a 1440 px viewport.
- The final live capture shows separate Like/Dislike controls, the Last Saved label, 23 measured regions, and no horizontal overflow: `files/sprite-editor-reactions-last-saved.png`.
- Desktop and 900 px captures had no horizontal page overflow.
- The deterministic visual harness measured 23 declared regions with zero overlap/touch blockers.
- A separate visual-capable model scored the redesigned editor 4/5 with no blocking findings. The built-in Azure vision pass could not run because the configured Azure subscription is disabled/read-only.

## Testing

- `node --test .github/extensions/sprite-editor/tests/renderer.test.mjs`
  - two-click action matrix
  - hotkeys and previous-tool toggle
  - focus and scroll preservation
  - Last Saved baseline persistence through brush, cleanup, Undo, and Redo
  - Save-driven baseline refresh
  - mutually exclusive per-sprite Like/Dislike persistence
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-11-sprite-editor-ux-refinement.review-ledger.json`

## Review harness

- Estimated 3 apples.
- Plan review: `gpt-5.4`, approved with six adopted changes, minor divergence.
- Code review: two rounds with `claude-sonnet-4.6`; all concerns resolved or adjudicated against the explicit brush-session boundary requirement.
- Ledger: `docs/knowledge/review-ledgers/2026-07-11-sprite-editor-ux-refinement.review-ledger.json`.

## Unresolved issues

- The Azure-backed LLM visual-review command remains blocked by disabled subscription `308f5463-c4b1-4cfb-94e9-c3e0fd0dc67c`.
