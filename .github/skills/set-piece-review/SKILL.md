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

Before invoking any judge, answer these structural questions:

- Where does your eye land first? Is that the intended focal point?
- Can you state the room's narrative verb from the screenshot alone, without
  reading the blockout?
- Do you see 2–4 readable vignettes, or just props?
- Is there intentional negative space, or is it wall-to-wall clutter?
- Does the room's composition mode match what you see (axial axis, clustered
  groups, radial ring, …)?
- Do any two adjacent props disagree on light direction or palette?
- Does anything read as the wrong physical size next to its neighbours?
- Would you remember this room? What is distinctive about it?

Any "no" is a finding; return to `set-piece-dress` or `prop-commission` with it.

## 3. Run the subjective judge — structured scorecard

Use the `visual-review` skill's **set-piece scenario** with
`docs/knowledge/game-design/set-piece-lookbook.md` as the style anchor.

Score each dimension **0–10** (advisory, never merge-blocking — rule #2).
A dimension scoring below 6 is a blocking finding that requires a return to
`set-piece-dress` or `prop-commission`. State the score, the evidence, and the
specific fix for any dimension below 6.

| #   | Dimension                  | What 10 looks like                                                                                    | What 0 looks like                                           |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | **Narrative verb clarity** | A player who has never read the blockout can state what happened here in one sentence                 | "There are some objects in a room"                          |
| 2   | **Focal point drama**      | The focal object creates tension or curiosity — not just size, but _consequence_                      | The largest object is merely central                        |
| 3   | **Vignette coherence**     | 2–4 named clusters each tell a micro-story; props within a cluster have clear relationships           | Props are distributed evenly with no grouping logic         |
| 4   | **Composition mode**       | The room's spatial grammar matches its declared mode (axial axis visible, clusters separated, …)      | Mode was declared in blockout but not executed              |
| 5   | **Negative space quality** | Empty zones are intentional; the player must traverse them; tension uses the absence                  | Empty zones are accidental leftovers where props didn't fit |
| 6   | **Landmark uniqueness**    | Something in this room could not be in any other room (specific prop, specific state, specific story) | Could be any generic dungeon room                           |

### Additional checks (non-scored, but blocking if failed)

- **Theme purity** — does every prop belong to this fiction? A deliberately not-scored
  check: the schema has no per-prop theme tags, but a wrong-theme prop is a finding.
- **Palette and lighting cohesion** — cross-prop disagreements on light direction or
  palette shift.
- **Pixel-art craft** — silhouette readability at game scale, dithering, outlines.
- **Crawler POV fit** — 3/4 top-down, 16px tiles, reality-show dungeon tone.

## 4. Apply

Write the layout via the `set-piece-editor` canvas `apply_layout` action, or edit
`src/shared/data/set-pieces.json` directly. Then **re-score** — applying can reshape
prop extents.

## 5. Report

In the session chat and in the handoff:

- the rendered before/after images
- the gate line for both (`before: 3/11 → after: 11/11`)
- the **six-dimension scorecard** with scores and findings for each dimension
- any non-scored findings (theme purity, palette, pixel craft)
- what you did about each finding (re-dressed, re-commissioned, or explicitly accepted)
- which props were reused, which were commissioned
- any threshold that felt wrong (feeds the eventual retune — do **not** edit
  `DEFAULT_THRESHOLDS` yourself)

The before/after pair plus the scorecard is the evidence rule #9 requires.
"It passes the score" alone does not satisfy it.

## Done when

The room renders, the image is posted, the six-dimension scorecard has been run
(all dimensions ≥6), non-scored findings are
addressed or accepted, the layout is applied, and the room still scores 11/11.

## Related

- `.github/skills/set-piece-dress/SKILL.md` (previous step)
- `.github/skills/visual-review/SKILL.md` (the subjective judge)
- `docs/knowledge/game-design/set-piece-lookbook.md` (style anchor)
- `src/shared/set-piece-render.ts`, `src/labs/set-piece-lab/`
- `.github/extensions/set-piece-editor/` (canvas with `apply_layout`)
