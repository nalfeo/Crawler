# Handoff: boarding-axe Floor 2 Equipment Icon

**Date:** 2026-07-18
**Session slug:** boarding-axe
**Issue:** nalfeo/Crawler#1346
**Aggregate tracking:** nalfeo/Crawler#1303 (`floor2-equipment-weapon-axe` wave)
**Apples:** 2🍎 (pure art — no game logic changes)
**Branch:** copilot/boarding-axe-icon-creation

## Systems touched

sprites

## What was done

### Completed this session

1. **Brief authored** — `briefs/weapons/boarding-axe.yaml` created with:
   - `type: weapon`, `name: boarding-axe`, `floor: 2`
   - Description: short-hafted boarding axe, wide asymmetric single-bevel blade +
     back spike for breaching, grungy worn iron with rust-brown staining
   - Vertical orientation (default weapon.json) — grip at bottom, axe-head at top
   - `variations` seed list + `minVariations: 6` for 16-variant sheet diversity
   - Inherits: 64×64, kenney-roguelike palette, 4×4 sheet, VLM judge enabled

2. **Plan comment posted** on issue #1346 (reply to intake comment #5009133488)
   via `engine-tools-reply_to_comment`.

3. **Fast verify passed** — all 1260 unit tests pass, no new regressions.

### Blocked

**Sprite generation blocked:** The `asset-request.yml` workflow requires the
`asset-request` label on issue #1346 to trigger. The label is missing (all 70
G2-B issues were created unlabeled per the wave-dispatch design in issue #1303).
Azure OpenAI credentials are not available in the Copilot SWE agent environment
(they are GitHub Secrets scoped to `asset-request.yml` steps only, per the
security posture documented in that workflow).

The axe-wave has not been started yet. Blade-wave regeneration runs are still
in progress (void-rapier completed 2026-07-18T04:41, dueling-saber completed
earlier same day).

## What needs to happen next

1. **Maintainer action:** Add `asset-request` label to issue #1346 to trigger
   the `asset-request.yml` workflow. The workflow will:
   - Synthesize a brief from the issue body (or use the authored
     `briefs/weapons/boarding-axe.yaml` if the pipeline is updated to check for
     existing briefs)
   - Generate 16 variants via Azure OpenAI `gpt-image-1`
   - VLM judge each variant, post results to the issue
   - Store the run in Azure Blob

2. **Sprite judge review:** Run the `sprite-judge` skill on generated variants.
   Check `combinedPassed: true`. Apply eyeball checklist:
   - Silhouette reads as AXE (not sword/mace) — asymmetric wide blade head
   - Single subject centered, grip at bottom, blade-head at top (vertical)
   - Anchor pixel opaque at grip position
   - No text, no glow, no enchantment

3. **Approve winner:** `npm run sprites:approve -- <runDir> --variant <N>` on
   the passing variant. Art keyed as `boarding-axe-var-N` in the catalog.

4. **Check-in:** `npm run sprites:checkin` → `asset-checkin` issue
   (art branch, no PR). Only runs locally (blocked in CI).

5. **Batch PR:** `asset-pr` skill consolidates `asset-checkin` issues into one
   art-only PR. PR closes issue #1346.

6. **Observe:** Confirm the sprite renders at game scale via `npm run lab` or
   headless probe before marking done.

## Wiring notes

The `boarding-axe` item does not exist in the game yet (not in `items.ts`,
`weapons.json`, `equipmentDefs.ts`, or `weaponDefs.ts`). Once approved art is
in the catalog as `boarding-axe-var-N`, it will auto-resolve via
`resolveItemSprite(registry, 'boarding-axe', seed)` when the game item is
eventually created. No explicit wiring code is needed.

The "runtime key: equipment/weapon/boarding-axe" in the issue body is metadata
describing the intended usage context, not a direct sprite lookup key. The sprite
lookup is purely by item ID.

## Policy compliance

- No sensor weakening (none needed — no sprites generated yet)
- Art-only diff (briefs/weapons/boarding-axe.yaml) — review-ledger-exempt per
  two-PR-lane policy (AGENTS.md rule #13: art-only diffs exempt)
- Apple estimate: 2🍎 (pure art, brief + plan only in this session)

## Key file

`briefs/weapons/boarding-axe.yaml` — the authored weapon brief, ready for
generation when the `asset-request` workflow runs.
