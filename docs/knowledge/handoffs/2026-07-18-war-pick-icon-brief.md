# Handoff: War-Pick Weapon Icon Brief — 2026-07-18

**Date:** 2026-07-18  
**Branch:** `copilot/war-pick-icon-design`  
**PR:** closes #1313, #1423  
**Agent:** Asset Forge (Graphics Designer persona)  
**Apple estimate:** 1🍎 (art-only, no code changes)

---

## What was done

Authored the sprite brief for the Floor 2 war-pick weapon icon.

- **Created** `briefs/weapons/war-pick.yaml` — vertical war-pick weapon brief
  - Runtime key: `equipment/weapon/war-pick`
  - Inherits all defaults from `data/sprite-types/weapon.json` (64×64, kenney-roguelike palette, 4×4 sheet, anchor at (32,56), vertical orientation, VLM judge enabled)
  - 2 authored seed variations; `minVariations: 8` to expand via Azure chat
  - Description emphasises the asymmetric pick-spike as the silhouette recognition cue

---

## Systems touched

- `briefs/weapons/war-pick.yaml` — new file (art-only lane, review-ledger-exempt)

---

## Blocked: Azure credentials unavailable in CI

`npm run setup:azure:env` detected a cloud/CI execution environment and exited without creating `.env.local`. Per AGENTS.md §"Azure-required sidecar policy" the launcher **must not** silently fall back to local/noop backends; this session stopped at the brief-authoring step.

---

## Remaining pipeline steps (for next session or local run)

```bash
# 1. From a local workstation with Azure access:
npm run setup:azure:env        # writes .env.local

# 2. Generate (warmup brief first recommended to dodge cold-call flake)
npm run sprites:run -- --brief briefs/weapons/war-pick.yaml

# 3. Review generated sheet — invoke sprite-judge skill
#    Check combinedPassed, NN.judge.json, eyeball checklist

# 4. Approve best variant
npm run sprites:approve -- generated/runs/war-pick/<run-id> --variant <N>

# 5. Check in
npm run sprites:checkin

# 6. Batch into art-only PR
npm run sprites:asset-pr
# => gh pr merge --auto --squash

# 7. Wire runtime key (after art PR merges)
#    Item icons auto-resolve: briefId (war-pick) → equipment/weapon/war-pick
#    Verify in npm run dev or headless probe
```

---

## verify:fast result

4254/4255 tests pass. The single failure in `epic-status.test.ts` (`git rev-parse 461b8a334a018ebbf6e81aa7b31f81c74e08aa6b`) is a shallow-clone environment issue unrelated to this change.
