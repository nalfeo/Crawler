# Handoff: iron-visor Floor 2 Equipment Sprite

**Date:** 2026-07-18  
**Apple estimate:** 1 🍎 (art-only, no code changes)  
**Issue:** nalfeo/Crawler#1375 (open — awaiting art generation)  
**Branch:** `copilot/create-iron-visor-icon`  
**Aggregate tracking:** nalfeo/Crawler#1303

---

## Systems touched

- `briefs/items/iron-visor-v1.yaml` — new brief added (art pipeline only)
- No runtime code changes; wiring is automatic via `resolveItemSprite`

---

## What was done

1. **Preflight** — confirmed `public/assets/generated/iron-visor-placeholder.png` exists as the current placeholder; manifest has `briefId: "iron-visor"`, `sourceRun: "placeholder"`.

2. **Brief** — authored `briefs/items/iron-visor-v1.yaml`:
   - Single iron faceplate / visor, front-facing
   - Defining feature: horizontal eye-slit (narrow dark opening)
   - Worn iron, rivets, slight dents — dungeon-flavored
   - 3 seed variations + `minVariations: 5`, `judge.enabled: true`
   - Inherits 64×64, kenney-roguelike palette, anchor (32,56) from `data/sprite-types/item.json`

3. **Verify** — `npm run verify:fast` passed: 1260/1260 tests, no blocking checks.

---

## Blocker: Azure generation not available in this session

The Copilot coding-agent session runs in CI (`GITHUB_ACTIONS=true`). The Azure setup script skips in CI environments, and the GitHub API write endpoints are blocked by the proxy. Azure generation therefore cannot run directly.

**Confirmed from run #490 logs (03:32 UTC):**

- The ingester scanned all `asset-request` labeled issues and found 4 (void-rapier, venom-dirk, dueling-saber, iron-cleaver)
- Iron-visor (#1375) was NOT found — it has no `asset-request` label
- The drain completed and queue was empty (`queue empty for 3 polls`)
- So iron-visor is currently not in the Azure queue

**The correct path** (requires human action):

1. **Apply `asset-request` label to issue #1375** → triggers `.github/workflows/asset-request.yml`
2. Pipeline: ingest → generate via Azure OpenAI (`gpt-image-1`) → VLM judge → approve best variant → push `assets/checkin-*` branch
3. After checkin branch lands: `npm run sprites:asset-pr` batches into art-only PR closing #1375
4. **No wiring code needed** — `resolveItemSprite` auto-resolves `iron-visor-v1` approved art at tier `BARE_REAL` (best), overriding the `PLACEHOLDER` tier entry

---

## Wiring notes

- Resolver path: `resolveItemSprite(registry, 'iron-visor', seed)` → `itemSpriteConcepts('iron-visor')` → `['iron-visor']` → `matchConcept(briefId, 'iron-visor')`
- After approval, manifest entry will have `briefId: "iron-visor"` (bare — the pipeline strips `-v1` on approval, confirmed by `iron-ore` precedent)
- `spriteName`: `iron-visor-var-N`, tier `TIER_BARE_REAL` — beats placeholder at `TIER_PLACEHOLDER`
- `EquipmentUI.ts` renders via `generatedEntry.textureKey` which maps to `spriteName`

---

## Resume instructions (for next agent)

When the label is applied and the pipeline completes:

```bash
# 1. Pull the checkin branch
git fetch --all
git log origin/assets/checkin-* --oneline | grep iron-visor

# 2. If not auto-merged, run asset-pr skill (see .github/skills/asset-pr/SKILL.md)
npm run sprites:asset-pr

# 3. Verify before-after
#    Before: public/assets/generated/iron-visor-placeholder.png renders
#    After:  public/assets/generated/iron-visor-var-N.png renders via EquipmentUI
```

---

## Acceptance criteria

- `public/assets/generated/iron-visor-var-N.png` committed (real generated art)
- Manifest entry has `briefId: "iron-visor"`, `sourceRun: "generated/runs/..."`, `sensorScore: "7/7"`, `judgeScore: "3"` or higher
- PR closes issue #1375 with title "art: add iron-visor Floor 2 equipment icon"
- `npm run verify:fast` passes post-merge
- Game renders real iron-visor icon in equipment slot (observe via `npm run dev` or headless probe)
