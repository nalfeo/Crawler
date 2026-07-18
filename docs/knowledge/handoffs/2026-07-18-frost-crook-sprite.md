# Handoff: frost-crook weapon sprite

**Date:** 2026-07-18  
**Agent:** Asset Forge (Graphics Designer persona)  
**Branch:** `copilot/create-frost-crook-icon`  
**PR:** Refs #1319  
**Estimate:** 1 🍎 (art-only, review-ledger-exempt)

---

## Summary

Authored the sprite brief for the **frost-crook** Floor 2 magic-focus weapon
(`briefs/weapons/frost-crook.yaml`). Brief validated against the pipeline schema
(`loadBrief` + Zod) and inherits all weapon-type defaults from
`data/sprite-types/weapon.json`.

Azure credentials were not available in the local runner environment — sprite
generation, judging, approval, and check-in must complete via the CI
`asset-request` pipeline (triggered by issue #1319 carrying the `asset-request`
label). This handoff records the design intent and what remains to be done.

---

## Systems touched

| File                                                       | Change                         |
| ---------------------------------------------------------- | ------------------------------ |
| `briefs/weapons/frost-crook.yaml`                          | New — frost-crook weapon brief |
| `docs/knowledge/handoffs/2026-07-18-frost-crook-sprite.md` | This handoff                   |

**Not yet changed (pending CI generation):**

- `public/assets/generated/manifest.json` — will gain `frost-crook-var-N` entry
- `src/shared/data/sprite-catalog.json` — will gain runtime-key mapping
- `public/assets/generated/sprites/` — will gain the approved PNG

---

## Brief design decisions

**Subject:** hooked magic staff (crook/shepherd's-crook silhouette)  
**Stable ID:** `weapon.frost-crook`  
**Runtime key:** `equipment/weapon/frost-crook`

Key choices in the brief:

- **Orientation:** vertical (default — grip at bottom, crook head sweeping to
  one side at the top). No `sensors.weapon.orientation` override needed.
- **Anchor:** `{x: 32, y: 56}` inherited from weapon type — grip center.
- **Color language:** deep midnight blue shaft, bright icy cyan crystal
  clusters, pale white frost rim-light, single 1-pixel glow along the
  inner arc. Cold palette with high contrast between shaft and ice.
- **Shape signal:** dominant arc + jagged crystal formations along the outer
  curve read unambiguously as "hooked magic staff" even at 64×64.
- **Variations:** 3 authored seeds (hexagonal crystal tip, spiral frost-rime
  bands, icicle spurs) + `minVariations: 8` for runner top-up.
- **Explicit exclusions in description:** no flames, chains, runes, orbs,
  trail effects — prevents common model drift for magic weapons.
- **Judge:** inherited `judge.enabled: true` from weapon type defaults — the
  VLM quality filter is expected to run in the CI `asset-request` worker
  (ADR-0043 bypass + Azure vision configured); ordinary CI gates outside that
  workflow refuse to run it.

---

## Pipeline state at handoff

| Step                                | Status                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------- |
| Scope (placeholder-audit)           | ✅ frost-crook confirmed missing from manifest                                              |
| Brief authored                      | ✅ `briefs/weapons/frost-crook.yaml`                                                        |
| Brief schema valid                  | ✅ all fields verified via `loadBrief` + Zod                                                |
| Generate (Azure)                    | ⏳ Pending CI — no local Azure credentials                                                  |
| Judge / score                       | ⏳ Pending CI asset-request worker (authorized VLM-judge bypass path)                       |
| Approve                             | ⏳ Pending CI                                                                               |
| Check-in (manifest + catalog + PNG) | ⏳ Pending CI                                                                               |
| Batch PR (asset-pr skill)           | ⏳ Pending post-CI                                                                          |
| Wire (engine lookup)                | ℹ️ Runtime key already embedded in Floor 2 equipment manifest; wiring is a separate code PR |
| Observe in game                     | ⏳ Pending wiring PR                                                                        |

---

## Issue tracking

- **#1319** (open, original) — addressed by this PR; final closure happens after generated art is approved, checked in, and wired
- **#1462** (closed as duplicate) — no action required

---

## Before / after observation

_Not yet applicable — sprite generation pending CI run._

Once the asset-request pipeline completes and art is checked in, a follow-up
wiring PR should:

1. Confirm `equipment/weapon/frost-crook` resolves in `entity-sprite-mappings.json`
   or equivalent runtime lookup.
2. Observe the weapon rendering in `npm run dev` or via a headless probe before
   declaring the task done.

---

## Next steps for follow-up agent

1. Trigger / confirm the `asset-request.yml` CI workflow ran against issue #1319.
2. Download the approved PNG from the run artifact and run `npm run sprites:approve`.
3. Run `npm run sprites:checkin` — updates manifest + catalog.
4. Run the `asset-pr` skill to batch into an art-only PR.
5. After merge, wire the runtime key via `npm run sprites:generate-wiring -- --since main`
   and open a code PR with full gates.
