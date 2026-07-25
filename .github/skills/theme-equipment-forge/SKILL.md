---
name: theme-equipment-forge
description: >-
  Build a complete themed equipment art collection through Crawler's durable
  roster, brief, sprite-sheet, and variant-approval pipeline. Use when asked to
  create a fantasy, medieval, samurai, ninja, pirate, historical, or modern
  streetwear equipment set with broad slot coverage and reusable variants.
---

# Theme Equipment Forge

Turn one authored theme into a cohesive base-equipment library without publishing partial work.
This skill composes the existing asset-generation and sprite-judge machinery at collection scale;
it does not replace their sensors, prompt rules, or approval semantics.

## Hard contract

A set is eligible to publish only when all of these are true:

- at least **5 distinct weapon types**;
- at least **11 distinct non-hand slots** from `SLOT_REGISTRY`;
- every item has **1–3 approved variants**;
- every item in every phase has a human up review;
- every phase has a whole-set human up review;
- every phase's collection cohesion judge scores **3/5 or better**.

`mainHand` and `offHand` are not counted toward the 11-slot coverage gate. The implementation derives
the gate from `SLOT_REGISTRY`; do not hard-code a different slot count.

## Intake

Ask one decisive question at a time until these authored inputs are fixed:

1. stable lowercase kebab set ID;
2. display name;
3. concrete design language covering materials, silhouette, palette, ornament limits, wear, and
   prohibited motifs;
4. a roster with five or more weapon types and 11 or more non-hand slots.

Write the plan to `data/theme-equipment-sets/<set-id>.json`, following
`data/theme-equipment-sets/classic-fantasy.json`. Keep concepts basic and reusable: variants should
come from hue, scale, particles, trim, and controlled silhouette reuse rather than over-specific
one-off lore.

## Four-phase loop

The durable phase order is:

`roster → briefs → sprite-sheets → variant-approval → complete`

For each phase:

1. Dispatch the trusted workflow:

   ```powershell
   gh workflow run theme-equipment.yml --field action=init --field set_id=<set-id> --field plan_path=data/theme-equipment-sets/<set-id>.json
   ```

   Use `action=init` only once. On later phases or rejected-only reruns, use:

   ```powershell
   gh workflow run theme-equipment.yml --field action=run-phase --field set_id=<set-id>
   ```

2. Open the committed canvas with stable set identity:

   `project:theme-equipment-review setId=<set-id>`

3. Review each item and the complete collection:
   - **Roster:** concept clarity, basic/reusable silhouette, required coverage.
   - **Briefs:** explicit theme propagation, bounded ornament, correct equipment footprint.
   - **Sprite sheets:** existing deterministic sensor results plus sheet-scale readability and
     collection cohesion.
   - **Variant approval:** invoke the `sprite-judge` methodology for each candidate; keep one to
     three winners per item, then inspect the collection contact sheet.

4. Up-review passing items. Down-review rejected items with actionable feedback. Passing items
   freeze; reruns may replace only unresolved/rejected item artifacts.
5. Up-review the whole set only after inspecting every item together.
6. Advance only when the canvas reports every canonical gate green. Any item verdict change
   invalidates both whole-set human review and collection-judge approval.

## Publication

When the state reaches `complete`, dispatch exactly one publication:

```powershell
gh workflow run theme-equipment.yml --field action=publish --field set_id=<set-id>
```

The publisher restores the existing generated-art surface and complete source runs, approves all
selected sparse variant indices, then calls the queue publisher once with the full set. State flips
from `held` to `published` only after that one queue commit succeeds.

## Guardrails

- Paid image generation and collection judging run on GitHub infrastructure, never as a broad local
  batch.
- Never publish a subset, skip a phase, lower the 3/5 cohesion threshold, reduce coverage, or approve
  zero/more-than-three variants to clear a gate.
- Never regenerate an up-reviewed item. If a user changes its verdict, the state machine deliberately
  invalidates collection approval before iteration resumes.
- Review state lives at `theme-sets/<set-id>/state.json` in the configured RunStore. Canvas
  `instanceId` is only a panel handle.
- Optimistic revision conflicts require refresh-and-retry; never overwrite newer review state.

## Related

- Agent: `.github/agents/equipment-theme-forge.agent.md`
- Canvas: `.github/extensions/theme-equipment-review/`
- Architecture: `docs/knowledge/adr/0073-phased-theme-equipment-set-pipeline.md`
- Operator guide: `docs/guides/theme-equipment-pipeline.md`
- Existing methods: `.github/agents/asset-forge.agent.md`,
  `.github/skills/sprite-judge/SKILL.md`
