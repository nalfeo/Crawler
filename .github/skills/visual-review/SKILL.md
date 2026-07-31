---
name: visual-review
description: >-
  Run deterministic + LLM visual UX review during development sessions (never CI).
  Use when asked to "review the UI visually", "run visual QA", "critique this UX",
  "judge the layout/style/readability", or "do a visual pass" for any game surface.
  Captures screenshots from any URL/state, enforces deterministic visual guards, and
  produces structured LLM critique (including pixel-dungeon thematic fidelity) with
  blocking findings and ordered fixes.
---

# Visual Review (Dev-only)

Use this skill to review **any UX surface** in Crawler with two layers:

1. **Deterministic visual checks** (required, CI-safe)
2. **LLM visual critique** (required for UX-heavy work, dev-session only)

## Commands

### Deterministic checks (required baseline)

```bash
npm run review:visual:deterministic
```

### LLM review (dev-only, non-CI)

```bash
npm run review:visual:llm
```

### Combined

```bash
npm run review:visual
```

## Review any UX surface

Pass URL + setup script + UX context:

```bash
npm run review:visual:llm -- \
  --url "http://127.0.0.1:4176/lab.html?lab=<target-lab>" \
  --setup-file "scripts/agent/review/setup/<target-state>.js" \
  --ux-name "<surface name>" \
  --ux-goal "<quality intent>" \
  --viewport "<width>x<height>" \
  --screenshot-name "<artifact-prefix>"
```

`--viewport` is optional and defaults to `1600x1000`. Dimensions must be positive integers.

### Example (equipment panel)

```bash
npm run review:visual:llm -- \
  --url "http://127.0.0.1:4176/lab.html?lab=ui-probe-lab" \
  --setup-file "scripts/agent/review/setup/ui-probe-equipment.js" \
  --ux-name "equipment panel" \
  --ux-goal "clean slot grouping, readable typography, no overlap, coherent icon use" \
  --screenshot-name "equipment-panel"
```

## Make findings actionable: declare regions (`window.__visualReview`)

The judge is **surface-agnostic**. To get pixel-grounded, non-oscillating feedback
on **any** surface, have your setup file declare the elements the judge should
measure. When present, this contract drives a real `MEASURED LAYOUT GEOMETRY`
table (so the model cites exact ids + pixel deltas in `precise_fixes` instead of
guessing) plus deterministic Node-side geometry checks.

```js
// In your --setup-file, after the surface has rendered:
window.__visualReview = {
  surface: 'inventory panel', // optional label, shown in the geometry table
  regions: [
    // Every meaningful element you want measured. `box` MUST be in the
    // SCREENSHOT's coordinate space (Crawler probes report DESIGN space,
    // 1280x720, which is the screenshot space here). The deterministic checks
    // use ABSOLUTE pixel thresholds (gap <= 1px, shared edge >= 8px, icon
    // escape > 1px) and the prompt tells the model the geometry shares the
    // screenshot's pixels — so a mismatched/arbitrary space produces wrong deltas.
    { id: 'inventory-panel', box: { x, y, width, height }, kind: 'panel' },
    { id: 'cell:0', box: { x, y, width, height }, kind: 'slot', parentId: 'inventory-panel' },
    { id: 'cell:0.icon', box: { x, y, width, height }, kind: 'icon', parentId: 'cell:0' },
    // ...
  ],
  expect: {
    // Opt in ONLY to the surface-specific hard requirements you actually have.
    // Leave these off (or omit) and the judge will not hunt for / hallucinate them.
    tooltipAfterHover: false, // empty cells should surface an identity/help tooltip
    statLabelsHumanReadable: false, // there is a stat-label column (words, not camelCase)
    sectionDividers: false, // there are section headings whose dividers must not cross glyphs
  },
  flags: [], // optional: author-declared deterministic blocker strings, merged as-is (rarely needed)
};
```

**Deterministic checks run over your regions (Node side):**

- **Sibling overlap** — two content regions with the same `parentId` must not
  intersect.
- **No breathing room** — sibling regions that touch (gap ≤ 1px with ≥ 8px shared
  edge) are flagged.
- **Icon escapes tile** — a `kind: 'icon'` region that leaves its `parentId` box by
  > 1px is flagged.

Use `parentId` to group siblings (so only same-parent regions are compared) and to
bind an icon to its tile.

### Worked non-equipment example (inventory)

`scripts/agent/review/setup/ui-probe-inventory.js` is a full worked example: it
loops `probe.getInventoryCellBounds(i)` until null to build one `slot` region per
cell, synthesizes the panel as the union bounding box of all cells, and declares
`expect: {}` (inventory has none of the three conditional requirements). Run it:

```bash
npm run review:visual:llm -- \
  --url "http://127.0.0.1:4176/lab.html?lab=ui-probe-lab" \
  --setup-file "scripts/agent/review/setup/ui-probe-inventory.js" \
  --ux-name "inventory panel" \
  --ux-goal "clear cell grid, readable item icons, coherent spacing" \
  --screenshot-name "inventory-panel"
```

### Actionability tips

- **Declare regions** so feedback is pixel-grounded — the tool prints a normalized
  `X.X/5` score, tags each blocker `[deterministic]` vs `[llm]`, and labels findings
  `NEW` vs `RECURRING` across runs (by finding identity), so you can track a fix
  across rounds instead of re-reading reworded prose.
- **Only opt into `expect.*` checks your surface actually has.** Equipment sets all
  three; most surfaces set none.
- **Give every element a stable `id`** — the judge references those exact ids in
  `precise_fixes`.

### Legacy equipment path (no declaration needed)

The equipment setup file does **not** declare `window.__visualReview`: it is detected
via the `getEquipmentSlotBounds` probe and uses the original equipment geometry path,
kept **byte-for-byte identical**. A surface that declares neither `__visualReview` nor
the equipment probe still runs, but with **no** deterministic geometry checks and a
loud non-gating warning (findings are screenshot-only, not pixel-grounded).

## Set-piece scenario (interior composition)

Set pieces get a dedicated critique pass because their failure mode is aesthetic, not
geometric. The deterministic half is **not** this skill — it is
`npm run setpiece:score -- <id>` (eleven checks: density, stacking, perimeter, floor
variety, anti-grid, real-world scale, focal point, wall anchoring, circulation, anchor
sanity, shell integrity). Run it
first; a room that fails the gate is not ready for subjective review.

**Setup path:** `scripts/agent/review/setup/set-piece-welcome-room.js` (copy per room),
or render directly via `src/shared/set-piece-render.ts` / the `set-piece-lab`.

**Style anchor:** `docs/knowledge/game-design/set-piece-lookbook.md` — 50 studied
interiors, five principles, and per-archetype references. Ground every finding in it.

Critique these, in order:

1. **Theme purity** — does every prop belong to this room's fiction? (Deliberately not
   a deterministic check: the schema carries no per-prop theme tags.)
2. **Narrative legibility** — can you tell what happens here without being told?
   "Floorplans first, decoration second" — does it read as a programmed space or as
   props scattered in a box?
3. **Palette cohesion** — do all props share the room's palette subset, or do some read
   as imported from another game?
4. **Lighting cohesion** — one light direction, one shadow convention. A top-lit prop in
   a left-lit room reads as pasted in.
5. **Scale believability** — do neighbouring props agree on physical size? (A chair must
   not out-measure a refrigerator.)
6. **Focal hierarchy** — does the eye land on the intended focal object first?
7. **Pixel-art craft** — silhouette readability at 16px, outline consistency, dithering
   discipline, no over-detailed mush.
8. **Crawler POV fit** — 3/4 top-down, 16px tiles, reality-show-dungeon tone.

**Archetype caveat:** boss dens are the documented density exception (sparser, darker,
higher contrast, one monumental focal object). Do not report a boss den as
under-dressed if it is deliberately austere — judge it against the lookbook's boss-den
references instead.

Findings are advisory and never merge-blocking. A finding that recurs across rooms
should be promoted into a deterministic check in
`scripts/agent/set-piece/composition-score.ts` rather than relying on model
consistency.

## Artifacts

Written under:

- `files/visual-review/*.png`
- `files/visual-review/*.review.json`

## Policy

- LLM visual review is **dev-session only** and **never CI-gating**.
- CI remains deterministic (no LLM-as-judge).
- For UX PRs, include latest visual-review artifact paths in handoff/PR notes.
