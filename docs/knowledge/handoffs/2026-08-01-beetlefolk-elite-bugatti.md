# 2026-08-01 beetlefolk-elite-bugatti brief

**Date:** 2026-08-01  
**Agent:** Asset Forge (Graphics Designer persona)  
**Issue:** #2562 — beetlefolk-elite-bugatti  
**Branch:** `copilot/asset-request-beetlefolk-elite-bugatti`  
**Apple estimate:** 1🍎 (art-only, review-ledger-exempt)

## Summary

Authored the sprite brief for the Bugatti Chitin Lieutenant — a sleek elite
beetlefolk soldier with a racing jacket, polished iridescent shell, gold racing
stripe, and wraparound sunglasses. The enemy is already fully wired into the game
(`enemies.floor2.json`, `generated-assets.ts` placeholder at line 636). This
handoff delivers the brief YAML ready for the Azure sprite pipeline.

## Systems touched

- `briefs/enemies/beetlefolk-elite-bugatti.yaml` — New; default size, type: enemy,
  floor 2, 3 color-variant variations, minVariations: 6, judge.enabled: true

## Blocker: Azure credentials unavailable in agent context

The Copilot coding agent's CI environment does not receive `AZURE_OPENAI_ENDPOINT` /
`AZURE_OPENAI_API_KEY` (only `APP_ID`, `APP_PRIVATE_KEY`, and `CRAWLER_CI_PAT` are
injected). `node_modules` is also empty (no network access), so `npm run verify:fast`
could not be executed locally. The change is purely additive YAML files with no
TypeScript edits — CI's own verify:fast will pass cleanly.

Per AGENTS.md policy the pipeline refuses to fall back to a local/noop backend
silently, so generation was not attempted beyond confirming the credential absence.

## State at handoff

| Step                                          | Status                                                 |
| --------------------------------------------- | ------------------------------------------------------ |
| Brief authored                                | ✅ `briefs/enemies/beetlefolk-elite-bugatti.yaml`      |
| Enemy entry in enemies.floor2.json            | ✅ Already present (id: beetlefolk-elite-bugatti)      |
| Placeholder in generated-assets.ts (line 636) | ✅ `'beetlefolk-elite-bugatti': 'beetlefolk-charger'` |
| verify:fast (CI)                              | ⏳ Will run in CI (YAML-only change, expected to pass) |
| Sprite generated                              | ⏳ Needs Azure pipeline                                |
| Sprite judged + approved                      | ⏳ Depends on generation                               |
| generated-assets.ts updated to real sprite   | ⏳ Depends on approval                                 |
| asset-checkin issue opened                    | ⏳ Depends on approval                                 |
| art-only PR merged                            | ⏳ Depends on check-in                                 |
| Rendering observed in real game               | ⏳ Depends on art PR merge                             |

## Brief design decisions

- **`facing: front`** — the brief explicitly requests front-facing camera for this
  elite soldier (unlike the boss which uses three-quarter). Tolerances relaxed
  slightly to `toleranceDeg: 35` to allow the slight forward lean described.
- **`interiorHoles.maxPixels: 400`** — slightly tighter than the boss (512) since
  the elite has a sleek shell rather than the bolt-riveted industrial plating that
  creates legitimate interior negative space.
- **3 jacket color variations** (crimson, jet-black, cobalt blue) chosen to
  maximize visual distinctness while keeping the gold racing stripe + iridescent
  shell constant as the identity anchor across all variants.
- **No `sizeVariant` override** — enemy entry has `spriteWidth: 2.2, spriteHeight: 2.2`
  which is the default enemy tile size.

## To complete sprite generation

**Option A — trigger the asset-request workflow:**

The `asset-request.yml` workflow runs with full Azure credentials and
`SPRITES_ALLOW_CI_PIPELINE=true`. Triggering it on issue #2562 (or re-labeling
with `asset-request`) will run the full pipeline end-to-end.

**Option B — run locally with Azure credentials:**

```bash
# With AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_API_KEY set (or via .env.local):
npm run sprites:run -- --brief briefs/enemies/beetlefolk-elite-bugatti.yaml
```

**After generation — judge + approve:**

```bash
# Review generated sheets in generated/runs/beetlefolk-elite-bugatti/<run-id>/
# Run sprite-judge skill: check combinedPassed + NN.judge.json per variant
# Approve the winner:
npm run sprites:approve -- generated/runs/beetlefolk-elite-bugatti/<run-id> --variant <N>
```

**After approval — update the placeholder mapping:**

In `src/shared/generated-assets.ts` line 636, change:

```typescript
'beetlefolk-elite-bugatti': 'beetlefolk-charger',
```

to the approved entry's `briefId`. Check the exact `briefId` field in the approved
manifest entry (for example `beetlefolk-elite-bugatti-v1`) and use that value:

```typescript
'beetlefolk-elite-bugatti': 'beetlefolk-elite-bugatti-v1',  // use the actual approved briefId
```

Note: `registry.variants()` groups entries by `briefId`, not by texture key. Using a
texture key like `beetlefolk-elite-bugatti-var-<N>` would fail to find the asset.
Copy the `briefId` field directly from the approved manifest entry.

where `<briefId>` is the approved variant's brief identifier from the manifest.

**Then check in + batch PR + observe:**

```bash
npm run sprites:checkin
npm run sprites:asset-pr
# After merge: npm run dev and confirm the Lieutenant renders in Floor 2
```

## Reference sprites used in brief design

- `briefs/enemies/beetlefolk-boss.yaml` — beetle family art direction, dark
  iridescent shell palette, beetlefolk anatomy conventions
- `briefs/enemies/gnome-wheelman.yaml` — "speed/racer" enemy style reference
  (variations format, minVariations: 6, forward-lean stance language)
- `public/assets/generated/beetlefolk-charger-var-0.png` — existing family member
  (the current placeholder; the generated Lieutenant should be visually related
  but noticeably more elite and streamlined)
