---
date: 2026-07-19
persona: Graphics Designer
systems_touched:
  - sprite-pipeline
  - sprite-workflow
apples: 1
---

# Session Handoff: brass-knuckles asset request (#1362)

## Date

2026-07-19

## Persona

Graphics Designer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

1🍎 exact — pure art pipeline prep. Brief already on main; generation blocked by
environment constraints.

## Summary

Resumed the brass-knuckles asset request (issue #1362) on PR #1642, branch
`copilot/create-brass-knuckles-icon-again`. The sprite brief
(`briefs/weapons/brass-knuckles.yaml`) was already authored and merged via PR
#1530. This session verified the brief is complete, ran `verify:fast` (89 test
files, 1295 tests — all passing), confirmed Azure credentials are unavailable in
this CI environment, and documented the required next steps for the maintainer.

## What Was Done

1. ✅ **Preflight**: ran `scripts/agent/preflight.sh` — clean.
2. ✅ **Persona + handoff review**: Graphics Designer; skimmed
   `2026-07-18-brass-knuckles-asset-request.md` and related sprite-pipeline
   handoffs.
3. ✅ **Brief verification**: `briefs/weapons/brass-knuckles.yaml` is complete
   and correct — diagonal orientation, anchor (20, 48), minVariations: 8, VLM
   judge enabled. Brief validates cleanly (only fails on missing
   `AZURE_OPENAI_ENDPOINT` — expected in CI).
4. ✅ **Baseline verify:fast passed** — 89 test files, 1295 tests, all green.
5. ❌ **Sprite generation attempted**: `npm run sprites:run -- --brief
briefs/weapons/brass-knuckles.yaml` failed with
   `Missing required env var 'AZURE_OPENAI_ENDPOINT'` — Azure credentials are
   not available in this CI environment (consistent with all prior sessions).
6. ❌ **Issue comment / label**: GitHub API write operations return
   `HTTP 403 Blocked by DNS monitoring proxy` — cannot post plan comment or
   re-apply `asset-request` label from this environment.
7. ❌ **Workflow dispatch**: `gh workflow run asset-request.yml` also blocked
   (same HTTP 403 proxy).

## Current Blocker

Issue #1362 currently has **no `asset-request` label** (stripped during
G2-B containment on 2026-07-18). The `asset-request.yml` GitHub Actions
workflow will not auto-trigger until the label is re-applied.

All write operations to GitHub (issue comments, label management, workflow
dispatch) are blocked in this CI sandbox environment.

## What Needs To Happen Next

The maintainer (or a human with write access) needs to do **one** of the
following:

### Option A — Re-apply `asset-request` label (recommended)

```
gh issue edit 1362 --add-label asset-request --repo nalfeo/Crawler
```

This triggers the `asset-request.yml` workflow, which will:

1. Run `sprites:ingest-once` to enqueue the issue into the Azure queue
2. Run `sprites:worker` to generate and score the sprite variants (4×4 sheet)
3. Post a completion comment on #1362 with the run ID and summary blob URL

**Important:** The workflow stops there. `checkin.ts` and `asset-pr.ts` remain
hard-blocked in CI (Constitutional §3). After the workflow completes, a human or
agent session outside CI must run the manual steps:
- `npm run sprites:approve -- <runDir> --variant <N>` — approve the best variant
- `unset CI && npm run sprites:checkin` — create the asset-checkin issue + branch
- `npm run sprites:asset-pr` (or `asset-pr` skill) — batch into a PR closing #1362

**Also important:** The workflow synthesizes a brief from the issue text via
`briefSelectorProvider` — it does NOT automatically use the existing
`briefs/weapons/brass-knuckles.yaml`. The anchor, sensor settings, and
`interiorHoles.maxPixels` documented here are from the hand-authored brief; verify
that the workflow-generated brief matches (or prefer running `sprites:run` directly
with `--brief briefs/weapons/brass-knuckles.yaml` in an Azure-connected environment).

### Option B — Manual workflow dispatch (label must be applied first)

```
gh issue edit 1362 --add-label asset-request --repo nalfeo/Crawler
gh workflow run asset-request.yml --repo nalfeo/Crawler
```

Manual `workflow_dispatch` alone is **not** sufficient — `SPRITES_INGESTER_TARGET_ISSUE`
is empty on dispatch, and the ingester sweeps only open issues carrying the
`asset-request` label. Without the label on #1362, the dispatch enqueues nothing for
this issue. Always restore the label before or alongside dispatching.

## Brief Design (already on main)

`briefs/weapons/brass-knuckles.yaml`:

- **Type**: `weapon` — inherits 64×64 size, `kenney-roguelike` palette, VLM
  judge from `data/sprite-types/weapon.json`
- **Orientation**: `diagonal` — brass knuckles are flat and wide; vertical
  silhouette reads as a ring and obscures the 4-hole plate. Diagonal ~45°
  shows the full finger-ring plate unmistakably. Follows
  `compact-disk.yaml`'s diagonal anchor pattern.
- **Anchor**: `{x: 20, y: 48}` — grip/palm-side bottom-left
- **diagonalToleranceDeg**: 8 — slightly relaxed to accommodate natural
  tilt variance in the bludgeon shape
- **minVariations**: 8 — ensures design diversity across the 4×4 sheet
- **Variations**: 8 seeds covering dented/oxidized, riveted, polished,
  spiked, leather-wrapped, dark iron, arcane-engraved, fluted alloy

## Runtime Resolution

Once sprite is approved and in the manifest, `resolveItemSprite(registry,
'brass-knuckles', seed)` in `item-sprites.ts` will find it via
`matchConcept(entry.briefId, 'brass-knuckles')` — no code changes required.
The runtime item concept is the bare `brass-knuckles` slug (not
`equipment/weapon/brass-knuckles`, which is art-tracking metadata only).

## Before / After

- **Before this session**: Brief on main, no art, issue open
- **After this session**: Brief verified, baseline green, blocker documented,
  maintainer action required to re-apply `asset-request` label
- **After label + workflow run**: `public/assets/generated/brass-knuckles-var-N.png`
  - manifest entry → auto-resolves in `resolveItemSprite`

## Links

- Issue: https://github.com/nalfeo/Crawler/issues/1362
- This PR: https://github.com/nalfeo/Crawler/pull/1642
- Brief PR (merged): https://github.com/nalfeo/Crawler/pull/1530
- Prior handoff: `docs/knowledge/handoffs/2026-07-18-brass-knuckles-asset-request.md`
- Aggregate tracker: https://github.com/nalfeo/Crawler/issues/1303
