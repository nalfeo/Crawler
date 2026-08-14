# Session Handoff: Surface-agnostic + actionable UX judge (`visual-review`)

## Date

2026-07-07

## Persona

Producer (tooling-leaning)

## Systems touched

ci-policy, devtools

## Apples

2🍎 estimated, 2🍎 actual (🎯 exact — plan review reshaped the approach into a
2-path decomposition but did not expand scope).

## What Was Done

Made the dev-only "UX judge" (`scripts/agent/review/visual-review-agent.ts`,
the `visual-review` skill) **surface-agnostic** and its feedback **actionable**.
It was hardcoded to the EquipmentUI paper-doll, so on any other surface (e.g.
InventoryUI during PR #835) it emitted guaranteed FALSE blockers, an empty
geometry table, equipment-only hard requirements, an un-normalized
`overall.score`, and free-text findings with no trajectory.

Changes:

- **Generic region contract** — surfaces may declare
  `window.__visualReview = { surface?, regions:[{id,box,kind?,parentId?}],
expect?:{tooltipAfterHover?,statLabelsHumanReadable?,sectionDividers?},
flags?:string[] }` (design space 1280×720). `captureScreenshot` now selects a
  harvest path: (1) `__visualReview` declared → **generic**; (2) else legacy
  `getEquipmentSlotBounds` present → **equipment-legacy** (the two original
  `page.evaluate` blocks moved **verbatim** into `harvestEquipment()`); (3) else
  → **none** (empty geometry, zero hard blockers, loud non-gating warning).
- **Pure Node analysis lib** `scripts/agent/review/visual-review-lib.mjs`
  (+ `.d.mts` types, + `.test.mjs` 22 tests): `computeGeometryBlockers`
  (sibling overlap / touch gap≤1 & shared-extent≥8 / icon-escape >1px),
  `normalizeOverallScore` (repairs the axis-sum bug), `findingKey`/`findingKeys`
  (strip only px/coords, keep semantic indices), `dedupeFindings`,
  `diffFindings` (NEW vs RECURRING). Node math runs for **declared** surfaces
  only; equipment never touches it.
- **Prompt split** — UNIVERSAL rules (overlap/clipping/blur/cramped/theming)
  always on; three CONDITIONAL rules (stat-label casing, empty-slot tooltip,
  section dividers) injected only when the matching `expect.*` is true; declared
  region ids injected so `precise_fixes` cite real elements; added a
  "`overall.score` is a single 1–5 rating, never the sum" line.
- **Reporting** — normalized `X.X/5` (+ raw note when repaired), each printed
  blocker tagged `[deterministic]`/`[llm]`, NEW-vs-RECURRING trajectory from the
  most recent prior `<screenshot-name>-*.review.json`, new persisted fields
  (`overall.raw_score`, `harvest_source`, `surface`, `regions_declared`,
  `finding_trajectory`), gate now uses the normalized score. Vision image label
  = ux-name.
- **Docs + example** — `.github/skills/visual-review/SKILL.md` documents the
  contract + a worked non-equipment example + actionability note (legacy
  equipment example kept). `scripts/agent/review/setup/ui-probe-inventory.js`
  declares a real `__visualReview` (synthetic panel = union bbox of cells + one
  `slot` region per cell).

**Observed in real artifacts (rule #10), not just the diff** — ran the actual
agent against a live lab server (`npm run lab`, :17441) with Azure vision:

- **Equipment before/after** (`files/visual-review/equipment-panel-before.review.json`
  vs `-after.review.json`): `deterministic_blocking_findings` **identical**
  (both `[]`) and the geometry table **identical** → byte-for-byte hard
  constraint met. BEFORE `overall.score=22` (defect #4 caught in the wild) →
  AFTER normalized `3.0`.
- **Inventory run** (`files/visual-review/inventory-panel.review.json`):
  `harvest_source="declared"`, **17 regions** → geometry table populated, the
  false `"Empty-slot tooltip is not visible…"` blocker is **gone**, and
  `precise_fixes` cite real ids (`inventory-panel`, `cell:0`).

## Key Decisions Made

- **Two independent harvest paths, not an adapter.** The separate-model plan
  review (gpt-5.4) BLOCKED the original "reshape the 18 equipment slots into
  regions and re-run the blocker math in Node" design as byte-for-byte-unsafe.
  Adopted the safer decomposition: equipment keeps its two `page.evaluate`
  blocks 100% untouched; generic Node math runs only for declared surfaces.
  Zero drift by construction (verified via byte-diff of both eval blocks before
  and after prettier).
- **`.mjs` lib + hand-written `.d.mts`.** `test:guards` runs the `.test.mjs`
  under plain `node --test` (no tsx) and tsconfig has no `allowJs`, so the lib
  is `.mjs` and the tsx-run `.ts` agent resolves types from the adjacent
  `.d.mts`.
- **Additive persistence only.** New reporting fields never mutate the two
  byte-diff targets (`deterministic_blocking_findings` + geometry table).

## What's Next / Blockers

- No blockers. PR opened off `main` on branch
  `nalfeo-visual-review-surface-agnostic`; `gh pr merge --auto --squash` armed.
- Future: promote more surfaces (HUD, shop, craft) to declare `__visualReview`;
  consider a tiny shared helper so setup files build regions from probe bounds
  with less boilerplate.

## Retrospective

### Lessons Learned

- **`tsx` / `review:visual:llm` does NOT auto-load `.env.local`.** Each
  PowerShell call is a fresh process; parse `.env.local` into `$env:` inline
  before invoking the agent, or Azure vision auth silently fails. `az` was
  already logged in, so `npm run setup:azure:env` (fast, env-only) was enough —
  no full provisioning needed.
- **The Windows Node/libuv exit-teardown crash is noise.** Every agent run ends
  with `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) … async.c` and
  exit `-1073740791` _after_ all output is printed and the artifact is written.
  Functionally fine — do not chase it.
- **Prettier does not reformat template-literal interiors**, which is why moving
  the equipment `page.evaluate` blocks verbatim survived `format` byte-for-byte.
- **`buildImagePart` in `azure-vision.ts` ignores `image.label`** (only the png
  is sent), so relabeling the vision image `equipment-ui`→ux-name has zero LLM
  effect — safe cosmetic fix.

### Mistakes Made

- **Started implementing before confirming the file scope.** The human
  interrupted twice ("the ask was to improve the agent's instruction file")
  because I jumped toward the code refactor without first reflecting the ask
  back. Early signal: the request named both SKILL.md (E) and code (A–D) — I
  should have `ask_user`-confirmed which surface first (I did, and the answer was
  "do both"), but only after the interrupt. Reflect-before-coding is cheap;
  do it first.
- Initially designed the equipment-adapter path that the plan review then had to
  block. Running the plan review _before_ writing the harvester (as the tier
  requires) is what caught it — the process worked, but I'd have saved a design
  pass by reasoning about byte-for-byte risk up front.

### Opportunities for Future Improvement

- A shared `regionsFromProbe(probe, spec)` helper would remove the per-setup
  boilerplate of looping bounds into `regions[]`.
- The libuv teardown crash could be muted with an explicit `process.exit(code)`
  after flushing, so future agents don't misread the exit code as a failure.
