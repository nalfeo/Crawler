# Handoff — 2026-06-25 corpse-fade-death-effect

## What Was Done

Reworked the dead-enemy death presentation. Previously a dead enemy got a
static skull marker floating above it for the whole death-linger window. Now:

- The **skull marker** is a brief "soul leaving" beat — it fades out and floats
  upward within ~1s of death, independent of the (much longer) corpse linger.
- The **corpse sprite** drains toward grey (via a multiply tint) and fades to
  nothing across the full linger window before the entity is removed.

### Approach

Extracted the decay-curve math into a new pure, Phaser-free helper
(`src/engine/corpse-decay.ts`) so it can be unit-tested in isolation, then wired
it into the rendering bridge (`src/engine/PhaserBridge.ts`). The renderer owns
the actual `setTint`/`setAlpha`/`setPosition` calls; the helper only decides the
numbers.

Used a cross-renderer multiply-tint for desaturation rather than Phaser 4's
per-object `Filters` (WebGL-only, render each object to its own framebuffer —
too costly with many simultaneous corpses in a bullet-heaven). A vertex-tint is
free, works on WebGL and Canvas, and combined with the fade reads as the body
draining of colour.

### Key Detail / Gotcha

The per-type `switch (entityType)` in the bridge has a `default` branch that
resets `alpha`/`scale`/`rotation` for living entities, and `enemy` flows into
it. So the corpse tint + alpha **must be applied after the switch closes**, not
inside the dead-enemy block (where it would be overwritten). The skull marker is
a separate scene image and is driven inside the dead block.

### Decay Curves (`corpse-decay.ts`)

- `life = clamp01(remainingMs / totalMs)` (1 at death → 0 at removal)
- Skull driven by absolute elapsed time: `skullProgress = elapsed / min(900ms, totalMs)`;
  `skullAlpha = 0.95 * (1 - progress)`, `skullRisePx = 16 * progress`
- Corpse desaturates over the front half (`GREY_RAMP_FRACTION = 0.5`) and fades
  over the back half (`FADE_OUT_FRACTION = 0.5`); tint lerps `0xffffff → 0x9a9aa0`
- `totalMs <= 0` is treated as a fully-elapsed corpse

### Files Changed

- `src/engine/corpse-decay.ts` (new) — pure helper: `computeCorpseDecay`, `corpseTint`, constants, `CorpseDecay` type
- `tests/unit/corpse-decay.test.ts` (new) — 11 unit + property tests
- `src/engine/PhaserBridge.ts` — wires the helper; skull fade/float in the dead block, corpse tint/alpha applied after the per-type switch
- `tests/unit/phaser-bridge.test.ts` — extended `MockImage` with tint support; rewrote the skull test to cover skull fade + corpse desaturate/fade

## Verification

- `npm run verify:fast` ✅ (typecheck + lint + tests)
- `npm run verify` ✅ (full suite: typecheck, lint, format, unit, coverage, integration, headless Floor 1 gate, build)
- Targeted: `corpse-decay.test.ts` + `phaser-bridge.test.ts` → 23 passed
- The effect is previewable in `gore-lab` (dying enemies render via `bridge.sync`); no new lab needed since no new ECS system was added.

## Apples

- Estimated: 🍎🍎
- Actual: 🍎🍎
- Verdict: 🎯 exact — new pure helper + test suite plus a localized bridge wiring fix; scope landed where expected (4 files, no lab/ADR).

## Systems touched

enemies
