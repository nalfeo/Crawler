# Handoff — Blood Vial Floor 2 Accessory Icon (Brief Authored)

**Date:** 2026-07-18  
**Branch:** `copilot/create-blood-vial-icon`  
**Persona:** Graphics Designer (Asset Forge)  
**Apples:** 1–2 🍎 (pure art wave, review-ledger-exempt)

## Systems touched

- `briefs/items/blood-vial.yaml` — sprite generation brief (authored)
- Issue [#1388](https://github.com/nalfeo/Crawler/issues/1388) — asset-request (blood-vial)
- Issue [#1303](https://github.com/nalfeo/Crawler/issues/1303) — aggregate Floor 2 equipment art tracking
- G2-A branch `nalfeo-floor-2-equipment-placeholders` — placeholder source (not modified)

## What was accomplished

1. **Brief authored** — `briefs/items/blood-vial.yaml`:
   - Type: `item` (inherits 64×64, kenney-roguelike palette, anchor, 4×4 sheet defaults)
   - Description: centered glass vial, deep crimson blood fill, cork/stopper, glass highlights, silhouette-first design, no magic glow or swirling effects
   - `sensors.edge.allowMainTouch: true` — appropriate for a tall narrow vial shape
   - `minVariations: 5` — ensures adequate diversity across variants
   - Judge enabled by default (from `item.json` defaults): `judge.enabled: true`

2. **Plan comment posted** on issue #1388 (reply to comment #5009215821)

3. **Brief committed** to branch `copilot/create-blood-vial-icon`

## What needs to happen next

### Step 1 — Re-trigger the asset-request workflow

The prior workflow run #29625257119 (blood-vial) was cancelled in a large batch cancellation at `2026-07-18T01:28:29Z`. The stale claim TTL is 45 minutes, so it should self-heal on the next workflow run.

**Action:** Trigger `workflow_dispatch` on `asset-request.yml` to regenerate issue #1388:

```bash
gh workflow run asset-request.yml -R nalfeo/Crawler
```

The ingester will pick up issue #1388 (labeled `asset-request`, author is `nalfeo` with OWNER association). It will synthesize the brief from the issue body OR use the committed `briefs/items/blood-vial.yaml` (whichever path the selector takes).

### Step 2 — Monitor the workflow run

The worker will post:

- `🧪 Started asset-request pipeline for blood-vial. Stage: synthesize`
- `✅ Asset-request pipeline complete. brief: blood-vial, run: <runId>, summary: <summaryPath>`

### Step 3 — Approve the best variant (non-CI required)

After the workflow completes, run on a dev box (NOT in CI — Constitutional §3):

```bash
# Download run from Azure blob (if needed, the sidecar can serve it)
npm run sprites:gallery  # starts sidecar, bootstraps .env.local

# OR from CLI — approve the highest-scoring combinedPassed variant
npm run sprites:approve -- generated/runs/blood-vial/<runId> --variant <N>
```

**Sprite Judge checklist** (apply to each `combinedPassed` variant):

- [ ] Silhouette reads as a vial/bottle at 16px on dark background
- [ ] No transparency holes or floating islands
- [ ] Cork/stopper visible at top, distinct from glass body
- [ ] Crimson/blood color clearly distinct from surrounding palette
- [ ] No magic glow, no swirling effects, no labels
- [ ] Glass highlights present (subtle white/blue-grey on one side)
- [ ] No anti-aliasing on edges

### Step 4 — Check in approved art

```bash
npm run sprites:checkin
```

Creates `assets/checkin-<slug>` branch and `asset-checkin` issue.

### Step 5 — Batch into asset PR

```bash
npm run sprites:asset-pr
```

Opens one art-only PR containing `blood-vial-var-N.png`, manifest entry, and catalog update. PR should close issue #1388.

### Step 6 — Wiring (separate code PR, tracked by #1303)

After art merges:

- The manifest entry `blood-vial-var-N` needs to be wired to runtime key `equipment/accessory/blood-vial`
- Run `npm run sprites:generate-wiring -- --since main` or manually update `entity-sprite-mappings.json`
- This is a code PR with full gates (not an art-only PR)

## Key metadata

| Field                      | Value                                             |
| -------------------------- | ------------------------------------------------- |
| Stable ID                  | `accessory.blood-vial`                            |
| Runtime key                | `equipment/accessory/blood-vial`                  |
| Brief path                 | `briefs/items/blood-vial.yaml`                    |
| Brief name                 | `blood-vial`                                      |
| Generated asset path       | `public/assets/generated/blood-vial-var-N.png`    |
| Manifest key (generated)   | `blood-vial-var-N`                                |
| Manifest key (placeholder) | `equipment/accessory/blood-vial` (in G2-A branch) |
| Production wave            | `floor2-equipment-ui-accessory`                   |
| Aggregate tracking         | #1303                                             |
| Asset-request issue        | #1388                                             |

## Blocking constraint (CI environment)

In the GitHub Actions CI environment where this session ran:

- Azure OpenAI credentials are scoped to workflow secrets (not available to the agent directly)
- `sprites:checkin` refuses under `process.env.CI` (Constitutional §3)
- The `setup-azure-env.ps1` script skips in Cloud/CI environments

Generation MUST happen via the `asset-request.yml` workflow. Approval and checkin MUST happen in a non-CI (dev box or non-CI Copilot session) environment.

## G2-A dependency

The blood-vial placeholder exists at `equipment/accessory/blood-vial` in the `nalfeo-floor-2-equipment-placeholders` branch. The art PR produced by this task should be stacked on that branch (or targeted at main after G2-A merges, per issue #1303 instructions).
