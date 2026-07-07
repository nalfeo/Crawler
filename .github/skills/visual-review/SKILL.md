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
  --screenshot-name "<artifact-prefix>"
```

### Example (equipment panel)

```bash
npm run review:visual:llm -- \
  --url "http://127.0.0.1:4176/lab.html?lab=ui-probe-lab" \
  --setup-file "scripts/agent/review/setup/ui-probe-equipment.js" \
  --ux-name "equipment panel" \
  --ux-goal "clean slot grouping, readable typography, no overlap, coherent icon use" \
  --screenshot-name "equipment-panel"
```

## Artifacts

Written under:

- `files/visual-review/*.png`
- `files/visual-review/*.review.json`

## Policy

- LLM visual review is **dev-session only** and **never CI-gating**.
- CI remains deterministic (no LLM-as-judge).
- For UX PRs, include latest visual-review artifact paths in handoff/PR notes.
