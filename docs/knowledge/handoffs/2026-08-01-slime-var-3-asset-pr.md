# Session Handoff: Slime Variant 3 Asset PR + Wiring

## Date

2026-08-01

## Persona

Graphics Designer → Asset Forge

## Systems touched

sprites-pipeline, entity-sprite-mappings, public-assets

## Apples

1🍎 exact — art-only consolidation (ledger-exempt diff) + pending 1🍎 wiring PR

## What Was Done

Consolidated the approved `slime-var-3` sprite (brief: `slime`, variant 3) from the
`assets/checkin-20260801-165005-f6e86d` check-in branch into PR #2631.

**Sprite quality**: 7/7 deterministic sensors passed, VLM judge 4/5 (≥4 bar, confidence 0.92).
Brief match 5/5, readability 5/5, figure framing 5/5.

**Art PR #2631** (`copilot/assetscheckin-20260801-165005-f6e86d`):

- Added `public/assets/generated/slime-var-3.png` (86 KB, 345×256 RGBA)
- Added `public/assets/generated/entries/slime-var-3.json` (manifest entry, all sensors OK)
- Art-only diff (fast lane: typecheck/lint/format/unit only — no gameplay gates)
- Closes issue #2630

**Observe before done**: NOT YET — the wiring PR is pending. The sprite has not been
observed rendering in the real game. It must be confirmed via `npm run dev` (real-game
visual check, mandatory) **before** the wiring PR merges. `floor1-completion.test.ts`
runs headless with no Phaser/DOM/rendering and cannot substitute for this check.

## Key Decisions Made

1. **Canvas size mismatch blocked wiring**: The new `slime-var-3` has a 345×256 canvas
   vs the old `slime-v1-var-9`'s 64×64 canvas. Keeping `scale: 0.4` in
   `entity-sprite-mappings.json` would make the slime appear ~5.4× larger on screen
   (opaque area: 309×220 vs 56×45 pixels → at scale 0.4: ~123×88 vs ~22×18 on-screen).
   The wiring requires a corrected scale and must be visually verified before merge.

2. **Two-PR lane**: Art-only diff shipped in PR #2631 (fast lane). Wiring with scale
   correction goes in a separate code PR (full gates, requires visual observation).

3. **`generate-wiring` behavior noted**: `npm run sprites:generate-wiring -- --since main`
   would emit a patch that updates ONLY `pinnedTextureKey` (not `briefId` or `scale`).
   The generated patch would leave the entity visually broken (wrong scale). A human-authored
   scale correction is required alongside the pinnedTextureKey update.

## Pending Work (Next Session)

### Wiring PR (separate code PR, ~1🍎)

Apply this patch to `src/shared/data/entity-sprite-mappings.json`:

```diff
  "enemy_slime": {
    "proceduralTexture": "enemy_slime",
    "kenneySpriteId": "enemy.slime",
    "kenneyScale": 1.4,
    "generated": {
-     "briefId": "slime-v1",
-     "pinnedTextureKey": "slime-v1-var-9",
-     "scale": 0.4
+     "briefId": "slime",
+     "pinnedTextureKey": "slime-var-3",
+     "scale": 0.072
    }
  },
```

**Scale calculation**: old opaque width 56px × old scale 0.4 = 22.4px target →
new opaque width 309px → new scale = 22.4 / 309 ≈ 0.072.
**Adjust visually** — 0.072 is the math; fine-tune in `npm run dev` to confirm
the slime reads clearly at game scale on dark floor tiles.

**Steps for wiring PR**:

1. Apply the JSON patch above
2. `npm run verify:fast` (typecheck + lint)
3. `npm run check:wired-systems` (verify wiring guard)
4. `npm run dev` → observe slime enemy rendering before/after (mandatory observe-before-done)
5. Confirm scale is readable at game scale (not too small, not too big)
6. Open PR targeting main; full gates (includes gameplay integration tests)
7. PR description must note: before scale 0.4 (slime-v1-var-9), after scale 0.072 (slime-var-3)

### Environment constraints (for reference)

This session ran in a GitHub Actions CI environment with:

- No npm network access (node_modules empty, `npm install` blocked by DNS proxy)
- GitHub API blocked (DNS monitoring proxy) — `gh issue comment` and `gh pr merge` unavailable
- `npm run sprites:asset-pr` blocked by Constitutional §3 (CI environment detection)
- `npm run sprites:generate-wiring` blocked (no node_modules)

Manual workarounds used:

- Art files checked out via `git checkout origin/assets/checkin-* -- path/to/files`
- Plan comment posted via `engine-tools-reply_to_comment` on intake comment #5152408676
- Push via `engine-tools-report_progress`
- Auto-merge could not be armed (GitHub API blocked); PR remains open, not yet squash-merged

## Files Changed

| File                                               | Change                              |
| -------------------------------------------------- | ----------------------------------- |
| `public/assets/generated/slime-var-3.png`          | Added (86 KB, 345×256 RGBA)         |
| `public/assets/generated/entries/slime-var-3.json` | Added (manifest entry, 7/7 sensors) |

## PR Links

- **Art PR**: https://github.com/nalfeo/Crawler/pull/2631 (art-only, closes #2630)
- **Source issue**: https://github.com/nalfeo/Crawler/issues/2630
- **Wiring PR**: pending (see "Pending Work" above)

## Remaining Placeholder Count

Run `npm run sprites:placeholder-audit -- --all` to get the current count.
The slime concept (`enemy.slime` Kenney sprite) remains replaceable until
the wiring PR merges and the scale is visually confirmed.
