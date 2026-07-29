# Handoff — Smarter Sprite Background-Color Picking

**Date:** 2026-06-26
**Session:** smarter-sprite-bg-color
**Persona:** Producer
**Apple estimate:** 🍎🍎 | **Actual:** 🍎🍎 | **Verdict:** 🎯 exact

## Why

The image-generation prompt builder embeds a requested background color so the
post-process step can flood-fill it away. For a **purple slime** it requested a
**magenta/pink** background — the _same hue family_ as purple — so the
corner-keyed background removal struggled to separate sprite from backdrop. The
operator expected something hue-distant like **green**.

## Root Cause

Two compounding problems in `pickContrastingBackgroundColor`
(`scripts/sprites/build-prompt.ts`):

1. **Wrong metric.** It maximized naive squared-RGB Euclidean distance. Bright
   magenta scores "far" from dark purple in RGB even though they share a hue, so
   RGB-maximin is not perceptual and picks a same-family color.
2. **No per-sprite signal / wiring gap.** `brief.palette.colors` is the _shared_
   quantization palette and is never populated per-sprite in the real pipeline
   (the resolved palette is returned separately as `LoadedBrief.palette` and
   never injected into the brief). So the function almost always fell through to
   the hard-coded **magenta default**. And contrasting against the shared
   110-color `kenney-roguelike` palette can never yield "green for purple" — that
   palette spans every hue, so there is no single distant color.

## What Was Done

### 1. Select by hue distance, not RGB (the fix)

Rewrote `pickContrastingBackgroundColor` to pick the `BACKGROUND_CANDIDATES`
entry that **maximizes the minimum circular hue distance** to the sprite's
dominant color(s), with min-RGB distance only as a tiebreak. For purple
(hue ~284°) this selects **neon lime** (`#39ff14`, hue ~111°, ~174° away) and
rejects magenta (~16° away).

### 2. Derive the dominant color from the brief PROMPT text

Because no per-sprite color exists at prompt-build time (pre-generation) and the
shared palette spans all hues, the only real per-sprite signal is the brief
**prompt** — and the synth guidance already tells authors to "name the dominant
colour by name". New exported pure helper `extractPromptColors(prompt)` scans the
lowercased prompt against a curated `COLOR_LEXICON` (word-boundary regex;
multi-word phrases like "sky blue" / "lime green" listed before bare words).
Achromatic words (black/white/gray/silver) are intentionally omitted — they carry
no hue. Explicit `brief.palette.colors` are still honored when present
(back-compat + existing tests).

### 3. Preserved fallbacks

- Chromatic signal present → `pickByHueDistance` (the new behavior).
- No prompt hue but explicit `palette.colors` present → original RGB-maximin
  (`pickByRgbDistance`), so legacy briefs are unchanged.
- No color info at all → `BACKGROUND_CANDIDATES[0]` (bright magenta default,
  unchanged) — keeps the "iron sword → magenta" baseline test green.

Added pure helpers: `rgbToHsv`, `hueDistanceDeg`, `toDominantColor`,
`isChromatic`, `extractPromptColors` (exported), `minRgbDistanceSq`,
`pickByHueDistance`, `pickByRgbDistance`, plus the `COLOR_LEXICON` table and a
`DominantColor` interface. No Phaser/Math.random/Date.now — fully deterministic.
No change needed in `generate-one.ts` (it already passes `brief.prompt`).

## Files Changed

| File                                      | Change                                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/sprites/build-prompt.ts`         | Hue-aware `pickContrastingBackgroundColor` + HSV/hue helpers + `COLOR_LEXICON` + exported `extractPromptColors`                                    |
| `tests/unit/sprites/build-prompt.test.ts` | +12 tests: `extractPromptColors` lexicon/word-boundary cases + hue-aware selection (incl. purple→green regression + `buildSheetPrompt` end-to-end) |

## Validation

- `npm run verify:fast` ✓ (typecheck + lint + 128 unit tests)
- `npm run verify` ✓ — full suite green: unit + coverage, integration (49 passed
  / 1 skipped), headless Floor 1 (68/68), production build.
- Targeted: `npx vitest run tests/unit/sprites/build-prompt.test.ts` → 36/36.

### Picks confirmed (probe, since deleted)

purple→neon lime · violet→neon lime · magenta→neon lime · red→electric cyan ·
green→bright magenta · blue→vivid yellow · grey/iron (no color)→bright magenta
default · "purple + lime-green eyes"→bright sky blue (avoids both) · red explicit
palette→electric cyan.

## Notes for Next Agent

- The dominant-color signal is the **brief prompt text**, by design. If a future
  pipeline change starts injecting a small per-sprite resolved palette into
  `brief.palette.colors`, the hue path will prefer the prompt words; that's
  intentional (the shared quantization palette spans all hues and would wash out
  the signal). Revisit only if briefs gain a trustworthy 2–3 color sprite palette.
- `COLOR_LEXICON` is the place to add hues/synonyms. Keep multi-word phrases
  before their bare-word components and rely on `\b` boundaries (locked by a test:
  "evergreen"/"goldfish" must not match green/gold).
- Achromatic-only prompts (e.g. "iron", "grey") correctly fall back to the magenta
  default — there is no hue to contrast.
- No `files/guard-telemetry.jsonl` this session, so no guard-telemetry section.

## Apples

Estimated 🍎🍎, actual 🍎🍎 (exact). One self-contained pure module
(`build-prompt.ts`) plus its unit test — no new ECS system, no wiring/schema
change, no rendering. The work was concentrated in getting the metric right
(circular hue distance + a small lexicon) and locking it with tests, which lands
squarely at the Small estimate.
