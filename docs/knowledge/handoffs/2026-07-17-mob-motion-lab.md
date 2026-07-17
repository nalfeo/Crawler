# Handoff: Generated mob motion prototype

**Date:** 2026-07-17  
**Persona:** Graphics Designer  
**Apples:** 3🍎 estimated, 3🍎 actual — exact

## Systems touched

devtools, vfx, enemies

## Summary

Added an isolated `mob-motion-lab` that loads approved mobile enemy variants
from the generated sprite manifest and previews three simulated animation clips
side by side:

- movement: step bob, squash/stretch, and lean;
- attack: wind-up, lunge, and recovery;
- hit reaction: recoil, shake, compression, fade, and white flash.

The lab provides a real-asset selector plus speed, intensity, scale, pause, and
deterministic scrub controls. Drawing uses manifest hold and center-of-gravity
anchors where available, quantized transforms, and nearest-neighbor rendering.

## Key decisions

- Kept the prototype in Canvas 2D rather than adding runtime Phaser animation.
  This makes visual experiments cheap while the motion language is still being
  evaluated.
- Selected manifest entries by unique variant key and excluded stationary
  spawner structures from the mob picker.
- Split manifest filtering and clip sampling into a pure model so the behavior
  can be unit tested independently from the lab shell.
- Exposed `window.__mobMotionProbe` and the standard `window.__uiProbe.ready()`
  alias for deterministic browser capture.
- Guarded image-load callbacks against stale sprite-selection requests after
  code review identified a race.

## Validation

- Baseline before implementation: `npm run lint`, `npm run build`, and
  `npm test` (5,673 tests) passed.
- `npm run verify:fast` passed after implementation and again after the review
  fix.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-17-mob-motion-lab.review-ledger.json`
  validates with plan review plus a two-round clean code-review loop.

## Observe before done

- **Before:** launched the parent commit and opened
  `lab.html?lab=mob-motion-lab`; the running lab shell displayed “Lab not
  found” and “No lab is registered with id `mob-motion-lab`.” Captured at
  `/tmp/mob-motion-lab-before.png`.
- **After:** launched the current lab and waited for
  `window.__mobMotionProbe.ready()`. The probe reported the selected real
  `baby-slime-v1-var-1` asset and all three panel states
  (`movement`, `attack`, `hit`). A deterministic 100 ms frame showed distinct
  bobbed movement, compressed attack anticipation, and bright recoil/flash at
  full 960 px canvas width. Captured at `/tmp/mob-motion-lab.png`.

## Follow-up

Use the lab to choose preferred amplitudes and timings before promoting any
motion recipe into `PhaserBridge`. Runtime integration was intentionally out of
scope for this prototype.
