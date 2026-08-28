# Visual Review Process (Dev Sessions)

This process is for **development sessions only**. CI remains deterministic and does **not** run LLM judges.

## 1. Deterministic visual gate (required)

Run:

```bash
npm run review:visual:deterministic
```

This runs visual/interaction e2e guards:

- `tests/e2e/inventory-flow.test.ts`
- `tests/e2e/hud-overlap-visual.test.ts`

These enforce objective rules (layout overlap, visibility, spacing/hit-target regressions).

## 2. LLM visual review agent (required for UI-heavy changes)

Run (default equipment probe review):

```bash
npm run review:visual:llm
```

The agent is generic: it captures a screenshot from any URL and sends it to Azure vision for structured critique across:

- layout consistency
- spacing balance
- hierarchy
- readability
- icon usage
- typography clarity
- thematic fidelity (must feel like a pixel dungeon crawler, not generic app UI)

For equipment, inventory, item-tooltip, loot-triage, and build-inspection
surfaces, the prompt also loads the checked-in RPG inventory UX lookbook rubric:

- `docs/knowledge/game-design/rpg-inventory-ux-lookbook.md`
- `scripts/agent/review/rpg-inventory-ux-lookbook-rubric.json`

This keeps the judge and UX Designer persona aligned on task readiness, decision
delta, state/candidate/delta separation, visible constraints, expert throughput,
and text safety without depending on a session-local PDF attachment.

Output artifacts are written to:

- `files/visual-review/equipment-ui-*.png`
- `files/visual-review/equipment-ui-*.review.json`

The command fails if:

- `overall.score < 4` (default threshold), or
- `blocking_findings` is non-empty.

### Reviewing any UX surface

Use `--url`, `--setup-file`, and UX context flags:

```bash
npm run review:visual:llm -- \
  --url "http://127.0.0.1:4176/lab.html?lab=ui-probe-lab" \
  --setup-file "scripts/agent/review/setup/ui-probe-equipment.js" \
  --ux-name "equipment panel" \
  --ux-goal "clean slot grid, no overlap, clear hierarchy and readable typography" \
  --screenshot-name "equipment-panel"
```

For other surfaces (HUD, shop, pause menu, main game), provide a setup script that opens the target state before capture.  
If no setup file is passed, the agent uses a default equipment-probe setup.

### Environment

Required:

- `AZURE_OPENAI_ENDPOINT`
- `AZURE_OPENAI_API_KEY`
- `AZURE_OPENAI_VISION_DEPLOYMENT` (or `AZURE_OPENAI_DEPLOYMENT`)

Optional:

- `AZURE_OPENAI_API_VERSION` (defaults to `2024-02-15-preview`)

## 3. Combined command

Run both deterministic + LLM reviews in sequence:

```bash
npm run review:visual
```

## Policy notes

- LLM visual review is **advisory during development** and **not used in CI**.
- CI quality gates stay deterministic (no LLM-as-judge).
- UI PRs should include the latest visual-review JSON findings and the captured screenshot artifact path in the handoff/PR notes.
