# 2026-07-16 Wide beetlefolk-boss brief + dimensions

**Date:** 2026-07-16  
**Agent:** Asset Forge (Graphics Designer persona)  
**Issue:** #1220 — beetlefolk-boss  
**Branch:** `copilot/fix-14006787-1257911858-28c13975-b630-438e-8cb0-b846bde049fb`  
**Apple estimate:** 1🍎 (art-only, review-ledger-exempt)

## Summary

Authored the wide brief for The Broodfather beetlefolk boss and updated the in-game
footprint to the correct wide 2:1 dimensions. The brief is ready for sprite generation
via the Azure pipeline.

## Systems touched

- `briefs/enemies/beetlefolk-boss.yaml` — New; wide sizeVariant (128×64)
- `src/shared/data/enemies.floor2.json` — `beetlefolk-boss`: `spriteWidth` 3.0 → 6.0

## Blocker: Azure credentials unavailable in agent context

The Copilot coding agent's CI environment does not receive `AZURE_OPENAI_ENDPOINT` /
`AZURE_OPENAI_API_KEY` (only `APP_ID`, `APP_PRIVATE_KEY`, and `CRAWLER_CI_PAT` are
injected). Per AGENTS.md policy, the pipeline refuses to fall back to a local/noop
backend silently.

**To complete sprite generation**, a maintainer or the asset-request workflow
(`asset-request.yml`) should run:

```bash
npm run sprites:run -- --brief briefs/enemies/beetlefolk-boss.yaml
# Then inspect the run dir, approve the best variant:
npm run sprites:approve -- generated/runs/beetlefolk-boss/<run-id> --variant <N>
```

The `asset-request.yml` workflow dispatches automatically on issue-label events with
`SPRITES_ALLOW_CI_PIPELINE=true` and full Azure credentials — triggering it on
issue #1220 would complete the pipeline end-to-end.

## State at handoff

| Step                                 | Status                                   |
| ------------------------------------ | ---------------------------------------- |
| Brief authored                       | ✅ `briefs/enemies/beetlefolk-boss.yaml` |
| In-game dimensions                   | ✅ `spriteWidth: 6.0, spriteHeight: 3.0` |
| Wiring (sprite-kind.ts)              | ✅ Already correct                       |
| Wiring (entity-sprite-mappings.json) | ✅ Already correct                       |
| Wide sprite generated                | ⏳ Needs Azure pipeline                  |
| Sprite approved + manifest updated   | ⏳ Depends on generation                 |
| verify:fast                          | ✅ 1254/1254 pass                        |
| floor2-enemy-art-wiring tests        | ✅ 5/5 pass                              |

## Lessons

- Copilot coding agent environment does not have Azure OpenAI secrets injected;
  they exist only in GitHub Actions workflow steps for the `asset-request.yml` flow.
- For future asset-request issues, triggering the `asset-request.yml` workflow
  (which has full Azure creds) is the right path for sprite generation in CI.
