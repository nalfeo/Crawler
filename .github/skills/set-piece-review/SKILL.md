---
name: set-piece-review
description: >-
  Close the Set Piece Designer loop by observing the room in a real running artifact:
  render it, look at it, run the subjective visual judge against the lookbook, and
  apply the final layout. Use when a set piece passes `npm run setpiece:score` and
  needs sign-off, when asked to "show me the room", "does this room look good", or
  before claiming any set-piece work done. Satisfies the project's observe-before-done
  rule — a passing gate is necessary but never sufficient.
---

# Set-Piece Review

The composition gate proves a room is not _structurally_ slop. It cannot prove the
room looks good. This skill is the subjective half, and it is also how the project's
"observe before done" rule (rule #9) is satisfied for set-piece work: reading the JSON
diff is not verification.

**Precondition:** `npm run setpiece:score -- <id>` reports 11/11.

## 1. Render it

Deterministic, headless, no interactive run required:

- `src/shared/set-piece-render.ts` is the shared renderer used by both the lab and the
  editor canvas — render from the layout directly.
- `scripts/agent/review/setup/set-piece-welcome-room.js` is the existing visual-review
  setup path; copy it for the room under review.
- The `set-piece-lab` (`npm run lab`, `?lab=set-piece-lab`) is the interactive view.
- The `set-piece-editor` canvas gives a live drag-and-drop view of the same layout.

**Post the rendered image inline in session chat.** The human's judgment is the top of
the quality ladder and they cannot exercise it on a table of numbers.

## 2. Look at it yourself

Before invoking any judge, answer these:

- Where does your eye land first? Is that the intended focal point?
- Can you tell what happens in this room without being told?
- Do any two adjacent props disagree on light direction or palette?
- Does anything read as the wrong physical size next to its neighbours?
- Are there dead zones — floor area belonging to no cluster?
- Would you believe a person uses this room?

Any "no" is a finding; return to `set-piece-dress` or `prop-commission` with it.

## 3. Run the subjective judge

Use the `visual-review` skill's **set-piece scenario** with
`docs/knowledge/game-design/set-piece-lookbook.md` as the style anchor. It covers what
the deterministic gate structurally cannot:

- **theme purity** — does every prop belong to this fiction? (deliberately not a
  deterministic check: the schema has no per-prop theme tags)
- **narrative legibility** — does the room tell its story?
- **palette and lighting cohesion** across props
- **pixel-art craft** — silhouette readability at game scale, dithering, outlines
- **Crawler POV fit** — 3/4 top-down, 16px tiles, reality-show dungeon tone

Judge findings are advisory, never merge-blocking (no LLM-as-judge in CI, rule #2).
Recurring findings should be promoted into deterministic checks.

## 4. Apply

Write the layout via the `set-piece-editor` canvas `apply_layout` action, or edit
`src/shared/data/set-pieces.json` directly. Then **re-score** — applying can reshape
prop extents.

## 5. Report

In the session chat and in the handoff:

- the rendered before/after images
- the gate line for both (`before: 3/11 → after: 11/11`)
- the judge's findings and what you did about each
- which props were reused, which were commissioned
- any threshold that felt wrong (feeds the eventual retune — do **not** edit
  `DEFAULT_THRESHOLDS` yourself)

The before/after pair is the evidence rule #9 requires. "It passes the score" alone
does not satisfy it.

## Done when

The room renders, the image is posted, the judge has run, findings are resolved or
explicitly accepted, the layout is applied, and the room still scores 11/11.

## Related

- `.github/skills/set-piece-dress/SKILL.md` (previous step)
- `.github/skills/visual-review/SKILL.md` (the subjective judge)
- `docs/knowledge/game-design/set-piece-lookbook.md` (style anchor)
- `src/shared/set-piece-render.ts`, `src/labs/set-piece-lab/`
- `.github/extensions/set-piece-editor/` (canvas with `apply_layout`)
