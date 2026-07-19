# Handoff: shock-baton sprite pipeline recovery

**Date:** 2026-07-19  
**Agent:** Graphics Designer (Asset Forge)  
**Apple estimate:** 1🍎 (docs-only recovery)  
**Issue:** #1348 (Asset request: shock-baton)  
**Aggregate tracking:** #1303  
**Prior handoff:** `docs/knowledge/handoffs/2026-07-18-shock-baton-brief.md`

---

## Summary

This session investigated why issue #1348 never produced generated art and documented the unblock path.

- ✅ Brief exists and is valid: `briefs/weapons/shock-baton.yaml`
- ✅ Root cause identified: G2-B queue saturation cancelled the original `asset-request.yml` run before jobs started
- ✅ Recovery path documented below
- ⚠️ Runtime wiring is **not** complete yet: approval/check-in alone will not make inventory render a `shock-baton` icon today

---

## Why generation did not happen

The G2-B seed wave opened ~70 equipment issues at once. `asset-request.yml` uses a shared worker concurrency path, and many runs were cancelled before any worker job executed.

The shock-baton request never got a successful worker run after that cancellation.

---

## Current runtime status (important)

The previous zero-code wiring conclusion was incorrect for current `main`:

- `shock-baton` is not present in `ITEM_CATALOG` (`src/shared/items.ts`)
- `shock-baton` is not present in `WEAPON_EQUIPMENT_DEFS` (`src/shared/equipmentDefs.ts`)
- `FLOOR2_EQUIPMENT_ART_DEFINITIONS` is currently consumed by issue-seeding/test paths, not by inventory runtime wiring
- Because `shock-baton` is missing from `itemArtIdentitySet()`, approve-time canonicalization does not bare-key `shock-baton-vN`

So: generated + approved art can land in the manifest/catalog, but inventory/equipment UI will not request `resolveItemSprite('shock-baton', ...)` until the item/equipment registrations exist.

---

## Required maintainer unblock steps

Issue #1348 currently has **no labels**. Add `asset-request` first.

```bash
gh issue edit 1348 --add-label asset-request --repo nalfeo/Crawler
```

Then choose either trigger path:

### Option A — fire a labeled event (targets #1348 directly)

```bash
gh issue edit 1348 --remove-label asset-request --repo nalfeo/Crawler
gh issue edit 1348 --add-label asset-request --repo nalfeo/Crawler
```

### Option B — one-time workflow dispatch sweep

```bash
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

`workflow_dispatch` discovery uses labeled asset-request issues, so adding the label is required in either path.

---

## What runs in CI after trigger

`asset-request.yml` runs in GitHub Actions and executes:

1. `sprites:ingest-once`
2. `sprites:worker`

The worker generates and judges variants **inside the CI job** (the workflow sets `SPRITES_ALLOW_CI_PIPELINE=true` for this sanctioned path).

---

## Landing the generated art

After a successful worker run, you still need approval/check-in/PR flow.

### Auto path (with caveat)

`g2b-harvest-approve.yml` can automate download + approve + PR creation, but current `ci-harvest-approve.ts` reconstructs run keys as `<base>-v1/<runId>/...` and can miss runs when selector output is `-v2`/`-v3`.

```bash
gh workflow run g2b-harvest-approve.yml --repo nalfeo/Crawler \
  --field dry_run=false --field create_pr=true
```

### Manual path

Before `sprites:approve`, explicitly materialize the Azure run artifacts locally under:

- `generated/runs/<brief-id>/<run-id>/summary.json`
- `generated/runs/<brief-id>/<run-id>/processed/*.png`

Then run:

```bash
npm run sprites:approve -- generated/runs/<brief-id>/<run-id> --variant N
npm run sprites:checkin
npm run sprites:asset-pr
```

---

## Observe before done (after art PR merge)

1. **Wiring check scope must use pre-merge ref** (not `--since main` while on `main`):

   ```bash
   npm run sprites:generate-wiring -- --since HEAD~1 --output summary
   ```

   (Or use the exact pre-merge SHA.)

2. **Runtime observation must use the real game surface**:
   - Use `npm run dev`
   - Equip/inspect where inventory/equipment icons render
   - Do **not** use `sprite-gallery` for this step (read-only run browser; no inventory/equip UI)

---

## Systems touched

sprite-pipeline, sprite-workflow, inventory, weapons
