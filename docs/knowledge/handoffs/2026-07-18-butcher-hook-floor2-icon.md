# Handoff: butcher-hook Floor 2 Equipment Icon

**Date:** 2026-07-18
**Session slug:** butcher-hook-floor2-icon
**Apple estimate:** 🍎 (1 apple — sprite brief + pre-existing test fix)
**Persona:** Graphics Designer

## Systems touched

sprite-pipeline, epic-status-test

## What was done

### Brief authored

Created `briefs/weapons/butcher-hook.yaml` — a minimal weapon brief for the
Floor 2 butcher-hook equipment icon. The brief inherits all defaults from
`data/sprite-types/weapon.json` (64×64, kenney-roguelike palette, vertical
orientation, 4×4 sheet, VLM judge enabled). The description specifies a
J/S-curved meat hook weapon with dark industrial iron, short wrapped handle,
and readable silhouette at game scale.

### Pre-existing test fix

Fixed a pre-existing double failure in `tests/unit/agent/epic-status.test.ts`:

1. **Shallow-clone SHA failure:** `rejects merge facts that point at a
non-commit git object` used `git rev-parse <HANDOFF_COMMIT>^{tree}` where
   `HANDOFF_COMMIT` is a hardcoded SHA (`461b8a3…`) not present in shallow CI
   checkouts. Fixed to use `HEAD^{tree}` — any tree object suffices; the test
   only needs to exercise the "not-a-commit" validator path.

2. **Stale epic-state hash:** `epic-state.json` stored SHA256
   `bbb2912c…` for the test file but the current content hashes to
   `79cf40fd…`. Updated `epic-state.json` to match.

Both failures existed before this branch; verified by `git stash` + rerun.

## Blocker: sprite generation requires manual action

Issue #1324 (authoritative) has **no `asset-request` label**. The
`asset-request.yml` GitHub Actions workflow ingests issues by label; without
it the job never runs and no Azure OpenAI call is made.

In this CI runner environment, Azure OpenAI credentials are exclusively held
by GitHub Secrets wired into the workflow — direct `sprites:run` is not
possible. Outbound HTTP (API.github.com) is also proxied/blocked.

### Required next step (maintainer action)

```
gh issue edit 1324 --add-label asset-request --repo nalfeo/Crawler
```

Once labeled, the `asset-request.yml` workflow will:

1. Ingest issue #1324 (brief auto-synthesized from issue body; the authored
   `briefs/weapons/butcher-hook.yaml` will be preferred if discovered)
2. Generate 16 variants via Azure OpenAI / GPT-Image-1
3. Run deterministic sensors + VLM judge
4. Post a completion comment on #1324 with the best variant

### After generation completes

```bash
# Fetch generated run artifacts from Azure Blob Storage
# (requires AZURE_STORAGE_* creds)
npm run sprites:approve -- generated/runs/butcher-hook/<runId> --variant <N>
npm run sprites:checkin
npm run sprites:asset-pr
gh pr merge --auto --squash
```

## Files changed

- `briefs/weapons/butcher-hook.yaml` — new weapon brief
- `tests/unit/agent/epic-status.test.ts` — fix shallow-clone SHA lookup
- `docs/knowledge/epics/floor-2-equipment/epic-state.json` — update stale test-file hash

## Context

- Authoritative issue: #1324 (`weapon.butcher-hook`, runtime key `equipment/weapon/butcher-hook`)
- Duplicate #1424 was queued in workflow run 29625257880 (surveyor-map run) but cancelled before the sprite was generated; #1424 was then closed as duplicate
- Epic tracking: `docs/knowledge/epics/floor-2-equipment/PLAN.md` (position #20)
- No ITEM_CATALOG entry yet (Floor 2 items are future/upcoming); art-plan catalog test is NOT triggered by this brief
