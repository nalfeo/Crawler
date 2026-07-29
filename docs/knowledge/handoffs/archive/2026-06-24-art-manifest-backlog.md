# Handoff: Art Manifest Backlog — Catalog Placeholder Item/Weapon Icons

**Date:** 2026-06-24
**Persona:** Producer / Art
**Branch:** nalfeo-art-manifest-backlog
**Scope:** PR Group F, Item 10 — docs/data only (no generation pipeline run)

## Problem

Several recent handoffs shipped procedural/placeholder sprites for items and
weapons and all left the same next step: "generate real authored art later when
provider access is available." Generation is access-gated, so instead of
generating art we needed to **catalog** every placeholder-backed icon into the
existing art asset-plan tracker so it can be picked up later.

## Investigation (extend, don't reinvent)

- `npm run sprites:asset-plan` (`scripts/sprites/asset-plan*.ts`) is the existing
  tracker. It reconciles `plans/**/*.art.yaml` entries against committed briefs,
  the generated manifest, and runtime integration targets, and reports
  per-asset lifecycle status + unresolved placeholders.
- `npm run sprites:plan-drafts` materializes draft briefs (under the gitignored
  `briefs/draft/`) for plan assets in `needs-art-placeholder`/`planned` status —
  this is the bridge from plan → runnable brief.
- The existing `plans/item-icons/floor1-item-icons.art.yaml` already tracks 8
  curated Floor-1 items using `integration: { kind: sprite-registry, id: <item-id> }`,
  which yields status `approved-not-integrated` and counts each as an unresolved
  placeholder. I reused that exact convention for consistency.
- **Source of truth for "what's on a placeholder":** the generated manifest
  (`public/assets/generated/manifest.json`). It has **102 entries with
  `sourceRun: "placeholder"`**, which map 1:1 onto the **102 items in
  `ITEM_CATALOG`** (20 of them tagged `Weapons`). Only 3 real (non-placeholder)
  sprites exist. So the real backlog is all 102 catalog items, far larger than
  the ~13 implied by the individual handoffs.

## What shipped (docs/data only)

Cataloged the 94 placeholder items **not** already in `floor1-item-icons.art.yaml`
into 5 new category-grouped art-plan files under `plans/item-icons/`:

| Plan file              | Type     | Assets |
| ---------------------- | -------- | ------ |
| `weapons.art.yaml`     | `weapon` | 20     |
| `materials.art.yaml`   | `item`   | 18     |
| `consumables.art.yaml` | `item`   | 20     |
| `key-items.art.yaml`   | `item`   | 18     |
| `misc.art.yaml`        | `item`   | 18     |

Total: 94 backlog assets + 8 existing Floor-1 entries = **102 = full ITEM_CATALOG**.

Each entry carries `id`, `type` (`weapon` for Weapons-tagged items, else `item`),
`label` (catalog name), a `brief` seed (silhouette guidance + the catalog
description), `placeholderInUse: true`, and `integration: sprite-registry:<id>`.
Running each plan through `sprites:asset-plan` reports every entry as
`approved-not-integrated` / unresolved placeholder — identical behavior to the
existing Floor-1 plan.

## Files

- **Added:** `plans/item-icons/{weapons,materials,consumables,key-items,misc}.art.yaml`
- **Added:** `tests/unit/sprites/art-plan-catalog.test.ts` — drift guard:
  - every committed `*.art.yaml` is schema-valid,
  - every `ITEM_CATALOG` id is tracked in **exactly one** plan,
  - each catalog entry uses the sprite type implied by its tags.
- **Updated:** `briefs/README.md` — documents the `plans/item-icons/` backlog and
  the guard test.

## Validation

- `npm run sprites:asset-plan -- --plan plans/item-icons/<file>` for all 5 files:
  94 unresolved placeholders total, all `approved-not-integrated`.
- `npm run verify` — full suite green: 1651 unit tests pass (incl. the new
  guard), integration + headless + build all pass.
- `scripts/agent/lab-gate-check.sh` passes (no ECS systems touched).
- `files/guard-telemetry.jsonl` does not exist — no guard-telemetry section.

## Known limitation / follow-up (out of scope)

Because placeholder PNGs are committed to the generated manifest as approved
entries (`sourceRun: "placeholder"`), the status engine treats them as
"approved." The `sprite-registry:<item-id>` integration convention is what keeps
them visible as unresolved placeholders, but it also means item icons will read
`approved-not-integrated` even after **real** art is later approved (item ids are
not in the `SPRITES` registry). A future improvement would teach
`resolveArtPlanStatus` to treat `sourceRun === "placeholder"` as not-approved so
real-vs-placeholder can be distinguished via `item-catalog` integration. Not
done here — this task is docs/data only.

## What's next

When provider access is available, generate real art per batch:

```bash
npm run sprites:plan-drafts -- --plan plans/item-icons/weapons.art.yaml   # emit draft briefs
npm run sprites:batch -- --briefs-dir briefs/draft/weapons                # generate candidates
npm run sprites:approve -- generated/runs/<name>/<run-id> --variant <n>   # approve winners
```

## Apples

**Estimate:** 🍎 (declared at session start)
**Actual:** 🍎🍎 — 5 generated data files + a guard test suite + a docs update; no
new types/systems and no lab, but larger than a single-file trivial edit once the
backlog turned out to be 102 items across categories and warranted a drift test.
**Delta:** +1 → 📉 **Under** (harder than the one-apple estimate implied).
**Hello kitties:** 0.4
