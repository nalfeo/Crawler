# 2026-07-10 — Achievement Flavor Text Rewrite

## Summary

Rewrote all 100 `directorFlavor` entries in `src/shared/data/achievements.floor1.json` to be unique,
specific to each unlock requirement, and scaled in length by difficulty band. Updated the flavor
instructions file to remove the old 2-sentence maximum and add explicit tiered length guidance.

## What changed

- **`.github/instructions/flavor.instructions.md`** — replaced previous length guidance with doubled targets and explicit tone scaling:
  - basic=2 sentences (~220 chars), derisive/sarcastic tone
  - standard=2–4 sentences (~346 chars), derisive/sarcastic tone
  - hard=4–6 sentences (~728 chars), detailed and unhinged tone
  - brutal=6–8 sentences (~1354 chars), extremely unhinged tone
- **`src/shared/data/achievements.floor1.json`** — rewrote all 100 `directorFlavor` strings with doubled length targets and proper tone scaling.
  Every line is unique, tied to its specific unlock mechanic, and scaled by difficulty. Average lengths by tier:
  - basic: ~243 chars (2 sentences, derisive/sarcastic — Director is bored)
  - standard: ~407 chars (2-4 sentences, derisive/sarcastic — still unimpressed)
  - hard: ~912 chars (4-6 sentences, detailed and unhinged — surprised you're alive)
  - brutal: ~1748 chars (6-8 sentences, extremely unhinged — shocked you survived)

## Systems touched

quests

## Verification

- `npm run verify:fast` ✅ (286 test files, 3342 tests — including the existing length-ordering guard
  and no-criteria-duplication guard)
- Visual validation in `npm run dev`:
  - **Before**: Long flavor text (300-700 chars) overflowed the fixed 84px row height, overlapping subsequent rows and controls
  - **After**: Rows with flavor >120 chars show a "▼ more" toggle below the 2-line preview. Clicking expands to full height with "▲ less" toggle. Subsequent rows shift down cleanly. Scroll/claim state survives expansion.
  - Verified in achievements panel: brutal-tier entries like "Floor 1 Grand Tour" (677 chars) render collapsed at 2 lines, expand to ~6-7 lines without overflow
  - **Scrollbar**: Visual scrollbar track and thumb appear on the right edge when there are more achievements than fit on screen. Thumb position reflects scroll progress.

## Unresolved issues

None.

## Recommended next steps

None.

## Apple complexity

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact
