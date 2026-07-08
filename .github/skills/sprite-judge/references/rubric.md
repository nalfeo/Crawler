# Sprite Judge — rubric, eyeball checklist, worked examples

Reference detail for the [`sprite-judge`](../SKILL.md) skill. The canonical style
authority is `docs/agent-os/sprite-style.md` (loaded verbatim into every
generation prompt AND passed to the VLM judge). This file explains **how to read
the three layers' output and turn it into a verdict** — it does not restate the
style guide.

## Layer 1 — deterministic sensors (`scoreCandidate`)

Each sensor returns `ok | warn | fail` with a message. A variant `passed` iff
every sensor is `ok`. What each one means, and what a failure actually indicates:

| Sensor                            | Fails when…                                 | Real cause → fix                                     |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------- |
| `dimensions-exact`                | canvas ≠ the brief's target px              | slicer/target mismatch → fix brief size or grid      |
| `alpha-binary`                    | semi-transparent edge pixels                | post-proc alpha threshold → fix pipeline, not sensor |
| `palette-membership`              | colors outside the allowed palette          | prompt/reference drift → tighten prompt/refs         |
| `opaque-bbox-fits`                | subject clipped by canvas edge              | too-large draw → brief padding/size                  |
| `opaque-ratio`                    | subject too sparse or fills the whole frame | framing → prompt "centered, small margin"            |
| `interior-transparency-holes`     | see-through gaps inside the silhouette      | model left holes → regenerate                        |
| `anchor`                          | anchor not opaque/derivable/center-of-mass  | footprint/anchor mismatch → brief anchor             |
| family: weapon orientation        | blade axis wrong for a weapon               | wrong family template → brief `family`               |
| family: character silhouette axis | front-facing axis wrong for a character     | same                                                 |

**Rule:** a sensor failure is a _pipeline or brief_ defect. Fix the brief
override, prompt, palette, or post-processor and regenerate. Do **not** edit the
sensor thresholds to pass a variant.

## Layer 2 — VLM judge (`judgeVariant`)

Opt-in (`judge.enabled: true`). Reads `<runDir>/processed/NN.judge.json`:

- `style_match` (1–5): matches `docs/agent-os/sprite-style.md` — palette, outline
  weight, shading, pixel density. Low → references/palette/prompt drift.
- `brief_match` (1–5): is this the thing the brief asked for? Low → prompt is
  describing the wrong subject/props.
- `readability` (1–5): does it read at 1× on the flat dark `#2a2a32` floor the
  judge composites it onto? Low → silhouette/contrast problem.
- **Any axis `< 3` → auto-reject.** `passed` iff all three ≥ 3.

The judge only ranks/scores **sensor-passing** variants, at most
`judge.maxVariants` (default 16, max 64), inside the USD `JudgeBudget`. Cache is
keyed on model + `PROMPT_TEMPLATE_VERSION` + variant bytes + refs + prompt, so
re-runs are cheap and stable.

Treat the judge as a **strong filter, not the final word** — it culls the
obviously-wrong so your eyeball spends time only on plausible variants.

## Layer 3 — the eyeball checklist (the final gate)

For every variant that passed sensors (and the judge, if enabled), post it inline
and check:

- **Reads at 16px?** Squint / imagine it 1× on a dark floor among other mobs.
  Silhouette instantly legible as _the intended thing_? If you can't tell what it
  is small, reject.
- **On-family with its siblings?** Same outline weight, palette, shading, and
  pixel density as the other Floor-N assets it sits beside. An off-family sprite
  that's individually fine still reads as "wrong game".
- **Clean shape?** No transparency holes, no floating pixel islands, no detached
  limbs/fragments, no edge clipping. (Edge half-sprites from the grid → reject
  that cell, expected.)
- **Right footprint?** Square mob in a square cell; **wide** creature / miniboss
  / boss in a wide cell (2:1-ish). Wrong footprint = brief bug, not a reject-only.
- **Right vibe?** Matches the brief's tone (e.g. `reality-show`, cozy office,
  sweaty-merchant). A technically-clean sprite with the wrong mood is a reject.
- **Anchor sane?** Feet/base where the engine expects it, so it won't float or
  sink when placed.

Accept the first variant that clears all of this; you do not need the "best"
of 16, just a clean, on-style, legible one.

## Worked verdicts

- **All 12 variants fail `alpha-binary`.** Not the model — the post-proc alpha
  threshold. Fix the pipeline/brief and regenerate; approving none is correct.
- **Variant 3: sensors pass, judge `readability: 2`.** Auto-rejected. The
  rationale says "muddy against dark floor" → low interior contrast →
  regenerate with a lighter rim / stronger outline; don't approve it.
- **Variant 5: sensors pass, judge all ≥ 4, but it's a slime-rat miniboss drawn
  as a small square.** Reject — but the fix is the **brief** (wide footprint),
  not just re-rolling the same brief. Re-brief wide, regenerate.
- **Variant 1: sensors pass, judge disabled, eyeball clean, on-family, reads at
  16px.** Accept → `sprites:approve -- <runDir> --variant 1`.
- **Two regen rounds, still off-style.** Escalate to the human with the sheet +
  judge rationales. Do not approve to clear the queue, and do not loosen a gate.

## Naming discipline (so approved art actually wires)

The manifest key = spriteName = engine texture key = catalog id = `<briefId>-var-<N>`.
Consumers resolve by **bare id**:

- **Item icons** resolve by `itemId === briefId` → brief id must be the bare item
  id (`health-vial`), never version-suffixed (`health-vial-v1`).
- **Set-piece `custom` refs** resolve by `requestId` → name the brief the exact
  `requestId` from `set-pieces.json`.
- **Enemies** wire via `mobDefs` + `entity-sprite-mappings.json` (or
  `sprites:generate-wiring`) → keep the concept name stable.

Version/variant-suffixed brief names are the exact orphan class that leaves real
art generated-but-unwired. When in doubt, name the brief what the consumer asks
for.
