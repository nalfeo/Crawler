# Handoff: ability-icons-batch-01 pipeline setup

**Date:** 2026-07-31  
**Branch:** `copilot/ability-icons-batch-01-run-e2e-test`  
**Issue:** #2488  
**Agent:** Asset Forge / Graphics Designer persona  
**Apple estimate:** 1🍎 (brief restructure + wiring = code-touching; art generation pending CI)

---

## What was done

### Root cause diagnosis

The CI workflow (`icon-batch.yml`) had already run twice for `ability-icons-batch-01` and failed with:

```
icon-batch-count-mismatch: produced 1 processed cell but iconBatch has 16 entries
```

`approveIconBatch` in `approve.ts` requires `candidates.length === iconBatch.length` exactly. The Azure image model (`gpt-image-1`) consistently generates only **1 filled cell** on a 4×4 sheet when asked to paint 16 distinct icon concepts simultaneously. The slicer (`slice-sheet.ts`) is data-driven and returns the honest cell count, so the mismatch throws.

This is a **systematic failure for all 16-entry batches** (`achv-icons-batch-01` through `-09`). Only `achv-icons-batch-10` (4 entries + 12 `emptyCells`) ever succeeded.

### Brief restructure

Split the 16-icon `ability-icons-batch-01.yaml` into four 4-icon sub-batches matching the proven working pattern (4 `iconBatch` entries + 12 `emptyCells` covering rows 1–3):

| Sub-batch | Brief file                               | Icons                                                      |
| --------- | ---------------------------------------- | ---------------------------------------------------------- |
| batch-01a | `ability-icons-batch-01.yaml` (modified) | battle-focus, veteran-instinct, magic-missile, frost-nova  |
| batch-01b | `ability-icons-batch-01b.yaml` (new)     | bless, stoneskin, curse, vampiric-touch                    |
| batch-01c | `ability-icons-batch-01c.yaml` (new)     | haste, combat-flow, stalwart-resolve, ever-vigilant        |
| batch-01d | `ability-icons-batch-01d.yaml` (new)     | blade-mastery, vital-targeting, brute-force, marksmans-eye |

All 4 briefs use `nativeCanvas: 1024`, `judge.enabled: true`, and the `emptyCells` pattern from `achv-icons-batch-10`.

### Wiring: iconBriefId

Added `iconBriefId` to all 16 ability entries in `src/shared/ability-presentation.ts`. Naming convention: `ability-icon-<ability-id>` (matches brief `id` field).

Also added **7 new spell entries** that were in `src/game/abilities/registry.ts` but missing from `ability-presentation.ts`:
`magic-missile`, `frost-nova`, `bless`, `stoneskin`, `curse`, `vampiric-touch`, `haste`.

Cooldown values corrected to match `registry.ts` exactly:

- magic-missile: 180
- frost-nova: 900
- bless: 1200
- stoneskin: 1500
- curse: 840
- vampiric-touch: 720
- haste: 1080

---

## Systems touched

- `briefs/icons/abilities/ability-icons-batch-01.yaml` — restructured (16→4 icons + emptyCells)
- `briefs/icons/abilities/ability-icons-batch-01b.yaml` — new
- `briefs/icons/abilities/ability-icons-batch-01c.yaml` — new
- `briefs/icons/abilities/ability-icons-batch-01d.yaml` — new
- `src/shared/ability-presentation.ts` — `iconBriefId` added to 9 existing entries; 7 new spell entries added with correct cooldown values

---

## What remains (maintainer action required)

1. **Trigger CI generation** for all 4 sub-batches via `workflow_dispatch` on `icon-batch.yml`:
   - `action=run, batch_ids=ability-icons-batch-01` (modified brief — 4 icons)
   - `action=run, batch_ids=ability-icons-batch-01b`
   - `action=run, batch_ids=ability-icons-batch-01c`
   - `action=run, batch_ids=ability-icons-batch-01d`

2. **Judge generated icons** — after CI runs, use `sprite-judge` skill to review each sheet. Apply eyeball checklist from sprite-style.md.

3. **Approve icons** — `npm run sprites:icon-batch -- approve --brief <path>` for each passing batch.

4. **Batch art PR** — `npm run sprites:asset-pr` to fold all open `asset-checkin` issues into one art-only PR.

5. **Observe in game** — confirm icons render in `npm run dev` (ability panel / HUD tooltips) and report before/after.

---

## Known limitations

- Azure OpenAI credentials are **not available** in the Copilot agent environment — generation can only run via GitHub Actions CI.
- The `gh` CLI proxy (`localhost:26831`) does not support REST API write operations in this environment, so workflow_dispatch cannot be triggered from the agent session.
- Wiring path: `getAbilityIconEntry()` in `src/engine/ability-icon.ts` resolves icons via `iconBriefId` → manifest lookup. Once art is in the manifest (post-approve + asset-PR), icons will display automatically.

---

## Commit

`f5af4fa` — `fix(briefs): restructure ability-icons-batch-01 into 4-icon sub-batches; wire iconBriefId for 16 abilities`  
Branch: `copilot/ability-icons-batch-01-run-e2e-test`
