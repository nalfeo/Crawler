# Handoff: Item-sprite asset-name normalization (retire `ItemDef.icon`, bare-key item art)

**Date:** 2026-07-08
**Persona:** Graphics/Content Designer
**Session:** Asset name normalization (delegated from "F1 asset burndown + f2 art", `cdb2b3a5-1fbd-4c33-afca-5232912acd7f`)
**Apples:** 🍎🍎🍎🍎 (4 — estimated and actual; see `docs/knowledge/metrics/apples/2026-07-08-asset-name-normalization.json`)

## Systems touched

inventory, sprite-pipeline, weapons

## What & why

Item icons never upgraded from their 2×2 placeholders because item art resolved by
**`briefId === itemId`** (bare), while real approved art shipped keyed `<item>-vN`. The bare id
matched the `<item>-placeholder` entry, never the real `-v1`. 16 item icons were stuck. The
maintainer's directive — _"In inventory, we shouldn't need separate icons vs item sprites. Just use
the real item sprite"_ — drove the full fix:

1. **`resolveItemSprite(registry, itemId, seed)`** (new `src/shared/item-sprites.ts`) — one
   version-tolerant, placeholder-last resolver. Ranks candidates **globally** across the itemId
   **and** its equipment `weaponId` (so `bone-club` → real `baseball-bat-*` art), tiering
   bare-real > versioned-real > placeholder, tiebreak non-null-anchor → ascending version → seeded
   pick. Never keys on sprite `type` (classified-dossier art is `character`).
2. **Retired `ItemDef.icon`** — deleted the field, the six `icon: id` assignments, and both
   version-pin overrides (`bone-club`, `classified-dossier`). Inventory + equipment panels now route
   through `resolveItemSprite`. "No separate icon" is now structurally true.
3. **Disk migration** (`scripts/sprites/normalize-item-art-names.ts`, `npm run
sprites:normalize-item-art`) — physically re-keyed 15 single-lineage item concepts to bare
   `<item-id>-var-N` (manifest key + briefId + catalog id/spriteId + PNG), and retired the
   `<item>-placeholder` entries/PNGs. Deterministic, idempotent, byte-safe (fails on
   both-exist-different-bytes rather than clobbering).
4. **`approve.ts` recurrence guard** — future item briefs whose name strips one `-vN` to a gameplay
   item id (ItemDef.id ∪ weaponId aliases) ship **bare**, so this class can't regress.

## Canonical convention (report to parallel sessions)

- **Items:** manifest key + `briefId` + PNG + `generated:` catalog id = **bare `<item-id>`**;
  variants only `-var-N`; **drop `-vN`**; **retire `<item>-placeholder`**.
- **Category prefixes `tile-`/`prop-`: KEEP** (namespacing, matches consumer keys).
- **Enemies / tiles / harvestable world-nodes:** keep versioned/pinned keys — different resolution
  contract; do NOT churn for cosmetic uniformity.

## Observe-before-done (rule #10, REAL artifact — not a lab)

- **PRIMARY:** `tests/integration/generated-manifest-engine.test.ts` — over the **real shipped
  manifest**, `resolveItemSprite` returns non-placeholder real art (PNG on disk) for all 15 items ×
  4 seeds + `bone-club→baseball-bat`.
- **NEW real-UI gate:** `tests/integration/inventory-ui-item-art.test.ts` — drives the **production
  `createInventoryUI`** factory (recording scene stub) against the real manifest. Records the actual
  textures the panel draws:
  - POSITIVE: 16 images, **0 placeholders** — `iron-ore-var-0`, `classified-dossier-var-2`,
    `copper-ore-var-6`, …, and `baseball-bat-v1-var-0` (bone-club via weaponId alias).
  - NEGATIVE CONTROL: empty registry → **0 images**, all cells fall to placeholder text (proves the
    harness exercises the real image/text branch, not always-recording).
- Before/after keys captured in the session's `files/observe-before-after.txt`.

## Guardrails honored (coordinator ask)

- `azure-mushroom-v1` and all `-v1` harvestable world-node keys **untouched**; scope was
  **inventory item icons only**.
- `classified-dossier` still resolves after icon-field removal (renders `classified-dossier-var-2`).
- Harvestables **not** folded into the item resolver (left to the harvestable session).
- **`baseball-bat` disk migration deferred** (swing-sprite lane): `bone-club` resolves to the
  still-existing `baseball-bat-v1-var-0` via the weaponId fallthrough; panels are already correct.
  `PhaserBridge` swing hardcode left in place. The bat disk rename + swing-hardcode removal + bat
  fixture updates ship as one atomic follow-up once the swing session coordinates.

## Validation

- `VERIFY_FULL=1 npm run verify` — **4180 passed, headless Floor-1 gate green, build green.** The
  lone failure is the documented **environmental** `floor2-scenario-initialization` parallel-load
  timeout (confirmed **7/7 pass in isolation**, 26s; my diff touches no `src/core`/Floor2 code).
- Review harness (4🍎): plan_review (gpt-5.4) + dual_plan_synthesis (gpt-5.5 + gemini-3.1-pro-preview,
  judge claude-opus-4.8) + code_review + multi_model_review (3 models, adjudicator claude-opus-4.8;
  1 valid concern = migration byte-safety, resolved). Ledger:
  `docs/knowledge/review-ledgers/2026-07-08-asset-name-normalization.review-ledger.json` (validates,
  exit 0).
- ADR: `docs/knowledge/adr/2026-07-08-item-sprite-name-normalization.md`.

## Follow-ups

- **`baseball-bat` atomic migration** (deferred) — coordinate with swing-sprite session, then run
  `npm run sprites:normalize-item-art -- --include-baseball-bat`, remove the `PhaserBridge`
  `'baseball-bat-v1'` hardcode, and update bat-keyed fixtures (`phaser-bridge.test.ts`,
  `ui-probe-lab/index.ts`). End-state consistent either way.
- 3 multi-real-lineage non-item concepts remain out of scope: `angry-roomba` (`-v2-v1`
  double-suffix bug), `welcome-sign-left`, plus consumables (`berserker-brew`, other session).
