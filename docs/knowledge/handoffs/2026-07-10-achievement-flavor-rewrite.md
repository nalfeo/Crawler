# 2026-07-10 — Achievement Flavor Text Rewrite

## Summary

Rewrote all 100 `directorFlavor` entries in `src/shared/data/achievements.floor1.json` to be unique,
specific to each unlock requirement, and scaled in length by difficulty band. Updated the flavor
instructions file to remove the old 2-sentence maximum and add explicit tiered length guidance.

## What changed

- **`.github/instructions/flavor.instructions.md`** — replaced "Prefer 1 sentence (2 max)" with a
  tiered length rule: basic=1 sentence, standard=1–2, hard=2–3, brutal=3–4.
- **`src/shared/data/achievements.floor1.json`** — rewrote all 100 `directorFlavor` strings.
  Every line is now unique and tied to its specific unlock mechanic. Average lengths by tier:
  - basic: ~110 chars
  - standard: ~173 chars
  - hard: ~364 chars
  - brutal: ~677 chars

## Systems touched

achievements

## Verification

- `npm run verify:fast` ✅ (286 test files, 3342 tests — including the existing length-ordering guard
  and no-criteria-duplication guard)

## Unresolved issues

None.

## Recommended next steps

- Play through the achievements panel to confirm popup readability for hard/brutal tier lines
  (they are intentionally long; a scrollable popup or a "read more" expansion could be worth
  considering if they overflow the current UI container).

## Apple complexity

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: exact
