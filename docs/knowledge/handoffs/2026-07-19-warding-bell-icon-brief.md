# Handoff: Warding Bell Floor 2 Accessory Icon Brief — 2026-07-19

**Date:** 2026-07-19  
**Branch:** `copilot/create-warding-bell-icon-again`  
**Issue:** closes nalfeo/Crawler#1384  
**Aggregate tracking:** #1303  
**Agent:** Asset Forge (Graphics Designer persona)  
**Apple estimate:** 1🍎 (art-only, no code changes)  
**Review harness:** exempt (art-only fast lane)

---

## What was done

Authored the sprite brief for the Floor 2 warding-bell accessory icon.

- **Created** `briefs/items/warding-bell.yaml` — item brief for the warding-bell Floor 2 accessory
  - Stable ID: `accessory.warding-bell`
  - Runtime key: `equipment/accessory/warding-bell`
  - Production wave: `floor2-equipment-ui-accessory`
  - Inherits all defaults from `data/sprite-types/item.json` (64×64, kenney-roguelike palette, 4×4 sheet, VLM judge enabled)
  - `sensors.edge.allowMainTouch: true` — consistent with all Floor 2 accessory items (blood-vial, gearwork-locket, lucky-feather, surveyor-map)
  - 3 authored variation seeds; `minVariations: 3`
  - Detailed description covering: bell silhouette, wearing loop/ring at crown, visible clapper, engraved rune band, warm brass/bronze/copper palette, patina treatment, no magical glow effects

### Visual design brief summary

The warding bell reads as a physical talisman:

- **Silhouette:** classic bell shape — wide at rim, domed crown with wearing loop, immediately reads as "bell" at 64×64
- **Clapper:** teardrop/cylindrical clapper tip visible at or just below the open rim
- **Surface:** one or two shallow engraved bands (chevrons or rune-lines) at the belly; worn but not crowded
- **Palette:** brass/bronze/copper warm metallics with 3–5 stops (bright highlight, warm base, shadowed flank, deep oxidized shadow, near-black outline); aged patina finish; no glow or magical effects
- **Variations:** (1) polished brass + chevron band, (2) aged dark-bronze + verdigris + rune-lines, (3) reddish-copper + hammered texture + no engraving

---

## Systems touched

- `briefs/items/warding-bell.yaml` — new file (art-only lane, review-ledger-exempt)
- `docs/knowledge/handoffs/2026-07-19-warding-bell-icon-brief.md` — this file

---

## Blocked: Azure credentials unavailable in coding-agent environment

`npm run setup:azure:env` detected a cloud/CI execution environment and exited without creating `.env.local`. The `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` environment variables are not injected into the coding-agent execution context.

Per AGENTS.md §"Azure-required sidecar policy": the launcher **must not** silently fall back to local/noop backends; this session stopped at the brief-authoring step.

Per the war-fan handoff (2026-07-18): sprite generation must go through the dedicated `asset-request.yml` workflow that has the Azure credentials available.

---

## GitHub plan comment

The `gh` CLI also reported no GitHub host configured (`none of the git remotes configured for this repository point to a known GitHub host`), so the required plan comment on issue #1384 could not be posted. The maintainer (@nalfeo) should be made aware of this as part of handoff.

The plan comment content is included below for manual posting if desired:

> **Plan:** Author `type: item` YAML brief inheriting from `data/sprite-types/item.json`; generate on Azure sidecar; judge with sprite-judge skill; approve, check-in, batch art-only PR. Visual design: brass/bronze ritual bell, wearing loop at crown, visible clapper, engraved band, warm metallic palette, no glow. Sensors: `edge.allowMainTouch: true`. 3+ variations. Closes #1384.

---

## Remaining pipeline steps

```bash
# Trigger via asset-request.yml workflow (has Azure credentials):
# Option A: workflow_dispatch on the issue
# Option B: re-label issue #1384 with 'asset-request' label to re-trigger

# Once generation runs:
# 1. Review generated sheet — invoke sprite-judge skill
#    Check combinedPassed + NN.judge.json + eyeball checklist
#    Accept if passes sensors + VLM judge ≥3 score; reject/regenerate otherwise

# 2. Approve best variant
npm run sprites:approve -- generated/runs/warding-bell/<run-id> --variant <N>

# 3. Check in
npm run sprites:checkin
# => creates asset-checkin issue with art branch

# 4. Batch into art-only PR (fold with any other open asset-checkin issues)
npm run sprites:asset-pr
# => gh pr merge --auto --squash

# 5. Wire (after art PR merges)
#    Item icons auto-resolve: briefId (warding-bell) maps to runtime key
#    equipment/accessory/warding-bell via itemId === briefId identity model
#    Confirm renders in: npm run dev  OR  headless probe
```

---

## Observe before done (deferred)

Visual confirmation (before/after in running game or lab) is deferred until generation completes. Before closing issue #1384, the approver must confirm the warding-bell icon renders correctly at game scale on the HUD/inventory screen with the accessory slot visible.

---

## Lessons

- In the copilot coding-agent environment, the firewall blocks external `openai.azure.com` endpoints — sprite generation **must** go through the dedicated `asset-request.yml` workflow.
- The `gh` CLI is not authenticated in the coding-agent execution context for this repository — GitHub API operations (posting issue comments) must be done via the workflow or by the maintainer.
- The `setup:azure:env` script detects CI/cloud and exits cleanly — this is correct behavior, not a failure.
