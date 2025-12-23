# 2026-07-18 — bone-chakram pipeline setup (asset-forge session)

## Summary

End-to-end setup for the bone-chakram Floor 2 thrown-weapon icon (issue #1359). All code
work (brief, ITEM_CATALOG entry, placeholder art, manifest entry) is committed. Art
generation is blocked by missing Azure OpenAI credentials in the coding-agent environment —
generation must run via the `asset-request.yml` CI workflow with GitHub Actions secrets.

## Systems touched

`briefs/weapons`, `src/shared/items.ts`, `tests/unit/items.test.ts`,
`plans/item-icons/weapons.art.yaml`, `public/assets/generated`

## Apple estimate

- Brief + item wiring + placeholder: **2🍎** (code-touching, review ledger required — ledger at `docs/knowledge/review-ledgers/2026-07-18-bone-chakram-item-wiring.review-ledger.json`)
- Real art approval + asset PR: **1🍎** art lane (review-ledger exempt)

## Prerequisite state confirmed

| Item                                                     | Status       |
| -------------------------------------------------------- | ------------ |
| Brief `briefs/weapons/bone-chakram.yaml`                 | ✅ Committed |
| `bone-chakram` in `ITEM_CATALOG` (`src/shared/items.ts`) | ✅ Committed |
| Test snapshot updated (catalog 127, Weapons 24)          | ✅ Committed |
| Art plan entry (`plans/item-icons/weapons.art.yaml`)     | ✅ Committed |
| Placeholder PNG + manifest entry                         | ✅ Committed |
| `verify:fast` — 1260 tests, 87 suites                    | ✅ Green     |

## Pipeline history for issue #1359

| Run               | Time (UTC 2026-07-18) | Outcome                                                                                                         |
| ----------------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| 29625235962       | 01:27:50              | Cancelled (batch cancel of ~30 floor-2 items)                                                                   |
| (batch worker)    | ~02:15                | Synthesized brief, promoted to `briefs/draft/weapons/bone-chakram.yaml`, then cancelled before image generation |
| (no further runs) | —                     | Pipeline stalled                                                                                                |

The item IS in the Azure Storage Queue (was enqueued by the 02:15 run). The 45-minute claim
timeout has long expired, so a fresh workflow trigger will re-enqueue and process it.

## What remains (requires maintainer action)

### Step 1 — Trigger image generation

```bash
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

This triggers `workflow_dispatch` which scans open `asset-request` issues, re-enqueues
bone-chakram (#1359), and drains the queue with the Azure OpenAI credentials from secrets.
Expected: the worker posts comments to issue #1359 with generated variant images (~5-15 min).

### Step 2 — Judge variants (Asset Forge session or manual)

Once the worker completes and posts results to issue #1359:

```bash
npm run sprites:run -- --brief briefs/weapons/bone-chakram.yaml --pick <N>
```

or use the sprite-judge skill to select the best variant.

### Step 3 — Approve the winner

```bash
npm run sprites:approve -- <runDir> --variant <N>
```

### Step 4 — Check in art

```bash
npm run sprites:checkin
```

Creates `assets/checkin-*` branch with the approved PNG + manifest update.

### Step 5 — Batch PR (asset-pr skill)

```bash
npm run sprites:asset-pr
```

Folds the checkin issue into a single art-only PR, closes issue #1359.

### Step 6 — Observe

After the art PR merges: confirm `equipment/weapon/bone-chakram` renders in the game via
`npm run dev` (the ADR-0051 manifest-only path auto-resolves item icons — no code PR needed).

## Brief highlights (for judge reference)

- **Orientation**: `diagonal`, `diagonalToleranceDeg: 10` (ring has no strong principal axis)
- **Anchor**: `{x: 32, y: 40}` (center of ring body; default y:56 grip anchor is wrong for chakram)
- **Description**: circular bone ring-blade, ivory-cream body, hairline fractures, sharpened outer rim, slight throw-tilt foreshortening
- **Variations**: cracked ring with bone-splint wrappings; engraved spiral grooves on cutting face

## Why no wiring PR is needed

ADR-0051 manifest-only resolution: `resolveItemSprite('bone-chakram')` looks up `bone-chakram`
in `manifest.entries` by `briefId`. The current placeholder entry already exists under key
`bone-chakram-placeholder`. When real art is approved, the manifest entry for the approved
variant (e.g. `bone-chakram-var-3`) maps to the asset file. The item system picks it up
automatically — no `entity-sprite-mappings.json` or `mob-defs` changes required.

## Sessions involved

- PR #1429 (`copilot/add-bone-chakram-icon`): authored brief, wiring, placeholder
- PR #1544 (`copilot/create-bone-chakram-icon`, this session): merged PR #1429 work, documented pipeline state
