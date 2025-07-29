# Handoff: Powder Keg Weapon Sprite Brief

**Date:** 2026-07-18
**Session slug:** powder-keg-sprite-brief
**Closes:** #1343 (partial — brief + plan done; generation pending)
**Apples:** 1🍎 (pure art task, no code changes)
**PR:** #1413

## Systems touched

sprite-pipeline

## What Was Done

1. **Brief authored**: Created `briefs/weapons/powder-keg.yaml` — squat powder
   keg seen from three-quarter angle, dark weathered oak body, grey iron hoop
   bands, short lit fuse with tiny orange-yellow flame. Vertical orientation
   (taller-than-wide keg silhouette; default sensor threshold ±5°). Inherits
   all defaults from `data/sprite-types/weapon.json` (64×64, kenney-roguelike,
   4×4 sheet, VLM judge enabled). Two seed variations (iron-chain keg, sparking
   cracks), `minVariations: 6`.

2. **Art plan updated**: Added `powder-keg` entry to
   `plans/item-icons/weapons.art.yaml` with the issue brief text, runtime key
   `equipment/weapon/powder-keg`, `placeholderInUse: true`, and
   `integration.kind: sprite-registry`.

3. **verify:fast passed**: 1260 tests, all guards green.

4. **PR #1413 pushed**: branch `copilot/create-powder-keg-icon`.

## Generation Blocker

The sprite generation requires the `asset-request` label on issue **#1343**.
That label triggers the GitHub Actions `asset-request.yml` workflow
(Azure OpenAI sidecar), which generates, judges, and stores the variants.

Issue #1343 was created programmatically (Floor 2 equipment manifest wave) and
the template label was **not applied**. In this cloud-agent session, the GitHub
API is blocked by the DNS monitoring proxy so the label cannot be added from
here. All GitHub API calls to `api.github.com` return 403.

**Action needed from maintainer:** Add the `asset-request` label to issue #1343.
Once added, the workflow will generate the sprite and store it. Then a follow-up
session can approve the best variant and check it in.

## Identity / Wiring Note

- Runtime key: `equipment/weapon/powder-keg`
- Brief ID: `powder-keg`
- Expected approved asset: `powder-keg-v1-var-N.png` in `public/assets/generated/`
- Sprite catalog entry will appear after `sprites:approve` + `sprites:checkin`
- Wiring via `npm run sprites:generate-wiring -- --since main` after art merges

## Key Decisions

- **Vertical orientation retained**: A squat keg with fuse pointing up has a
  taller-than-wide silhouette → vertical sensor passes without override.
- **Default anchor (32, 56)**: Base of the keg is the natural attach point.
- **`minVariations: 6`**: Two explicit seed variations + 4 LLM-expanded variants
  give 6 distinct briefs for the 4×4 sheet (16 cells total = max variety).
- **VLM judge left enabled** (inherited): Unattended quality gate.
- **No wiring in this PR**: Art-only fast lane; wiring is a separate code PR.

## What's Next

1. Maintainer adds `asset-request` label to #1343 → workflow generates art
2. Follow-up session: review generated variants, pick best, run
   `npm run sprites:approve -- <runDir> --variant <N>`
3. `npm run sprites:checkin` → creates `asset-checkin` issue (art branch)
4. `npm run sprites:asset-pr` (asset-pr skill) → batch art PR → auto-merge
5. After art merges: wire in `equipment/weapon/powder-keg` (separate code PR)
6. Close #1343
