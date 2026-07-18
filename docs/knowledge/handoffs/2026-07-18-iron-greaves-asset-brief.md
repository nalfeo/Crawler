# Session Handoff: Iron Greaves Asset Brief — Floor 2 Equipment Icon

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, inventory

## Apples

1🍎 estimated, 1🍎 actual (pure art brief — no engine code changes)

## What Was Done

Created a high-quality sprite brief for the `iron-greaves` Floor 2 equipment icon (issue #1385).

**Brief file**: `briefs/items/iron-greaves.yaml` — authored with detailed description of iron leg-plate armor with dungeon wear, three distinct variations (riveted knee cap, segmented bands, gothic-style with pointed toe-cap), and `allowMainTouch: true` edge sensor override for the tall vertical form factor.

**Generation pipeline status**: Azure OpenAI credentials are not available in the coding agent environment (intentionally kept away per the asset-request workflow security design). The generation will run via the `asset-request.yml` GitHub Actions workflow on the next ingest trigger for issue #1385.

**Wiring confirmed — NO code changes required**: `EquipmentUI.ts` and `InventoryUI.ts` both call `resolveItemSprite(registry, 'iron-greaves', seed)`. This function scans manifest entries matching `briefId === 'iron-greaves'` (TIER_BARE_REAL) or `briefId === 'iron-greaves-vN'` (TIER_VERSIONED_REAL). Once art is approved with briefId `iron-greaves` → manifest key `iron-greaves-var-N`, the engine automatically uses it. No registry entry or code change needed.

**Pre-existing test failure confirmed**: `tests/unit/agent/epic-status.test.ts` fails on this branch due to a hardcoded commit hash (`461b8a334a...`) not present in the local clone. This failure pre-dates this session and is unrelated to the iron-greaves work.

**Observation plan**:

- Before (current state): `iron-greaves` in equipment panel shows the placeholder PNG at `public/assets/generated/iron-greaves-placeholder.png` (128×128 generic leg-armor icon)
- After (once art is generated and approved): `resolveItemSprite(registry, 'iron-greaves', seed)` returns a TIER_BARE_REAL manifest entry; the legs equipment slot shows the real pixel-art iron greaves icon
- Verification: `npm run dev` → open character → equip iron-greaves → observe legs slot icon; or headless probe via `EquipmentUI` screenshot assertion

## Key Decisions Made

| Decision                                  | Rationale                                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Brief type = `item`                       | Inherits 64×64 size, kenney-roguelike palette, 4×4 sheet, anchor (32,56) from `data/sprite-types/item.json`                                      |
| Brief ID = `iron-greaves` (bare)          | Item art identity contract (ADR 0051): item art must be bare-keyed so `resolveItemSprite` resolves it as TIER_BARE_REAL, not TIER_VERSIONED_REAL |
| `allowMainTouch: true`                    | Iron greaves are tall vertical form; the leg plates may naturally touch top/bottom at 64×64 scale without being "cut off"                        |
| `judge.enabled: true` (inherited default) | VLM judge quality gate active — inherited from `data/sprite-types/item.json`                                                                     |
| `minVariations: 5`                        | Gives the sensor+judge pipeline adequate headroom to reject weak candidates                                                                      |
| 3 variation prompts                       | Different silhouette approaches: riveted kneecap (classic), segmented banding (articulated), gothic flare (dramatic)                             |
| No code wiring PR                         | Auto-resolution via `resolveItemSprite` by item ID — no engine change required                                                                   |

## What's Next / Blockers

**Immediate**: The `asset-request.yml` workflow needs to re-run for issue #1385 to generate, judge, and check in the art. Options to trigger:

1. Maintainer reopens / re-labels issue #1385 → workflow fires automatically
2. `gh workflow run asset-request.yml` (manual dispatch)
3. Next batch asset-request trigger will also re-process pending issues

**After generation completes**:

- The workflow creates an `asset-checkin` issue with the approved art on a branch
- Run `npm run sprites:asset-pr` (or `asset-pr` skill) to batch it into an art-only PR
- The art-only PR is review-ledger-exempt and auto-merges
- After merge, `resolveItemSprite` automatically serves the real art — no further code work

**Blocker**: Azure OpenAI credentials not available in coding agent environment (by design per security model). Generation must happen via GitHub Actions workflow.

## Retrospective

### Lessons Learned

- The asset-request pipeline security model intentionally prevents the coding agent from generating art (Azure credentials in GitHub secrets, scoped away from the agent runner). This is by design and documented in the workflow header.
- The `resolveItemSprite` item resolution is fully automatic — any approved sprite with `briefId: 'iron-greaves'` (bare or versioned) will be picked up without code changes. No manual wiring needed for equipment item icons.
- The brief YAML in `briefs/items/` is for manual `npm run sprites:run` invocations. The automated pipeline's `issue-pipeline.ts` synthesizes its own brief from the issue body text and writes to `briefs/draft/`.
- The "runtime key" `equipment/feet/iron-greaves` in the stable manifest is a production-wave tracker, not an engine texture key. Engine texture key = `iron-greaves-var-N` (the manifest entry's map key).
- The pre-existing `epic-status.test.ts` failure (hardcoded commit hash) should be investigated separately.

### Mistakes Made

- Attempted to post a plan comment via Gitea API (localhost:26831) — that endpoint is unavailable (410 Gone). Issue comments go through the GitHub API only, which is blocked from the agent environment by the DNS proxy.
- Attempted `npm run sprites:run` without checking for Azure credentials first. Should always check env vars before attempting generation in CI/agent environments.

### What Would Be Done Differently

- Check Azure credential availability early in the session before attempting the generation step
- Use the `asset-request.yml` workflow dispatch approach as the primary generation path when running as a coding agent

## Files Changed

- `briefs/items/iron-greaves.yaml` — new brief for iron greaves equipment icon
- `docs/knowledge/handoffs/2026-07-18-iron-greaves-asset-brief.md` — this file
