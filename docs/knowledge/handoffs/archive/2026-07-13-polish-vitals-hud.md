# Core vitals HUD layout polish

## Systems touched

hud-ux, mobile-ux

## Persona

UX Designer

## Apples

Estimated: 3🍎. Actual: 3🍎. Verdict: exact — six production files, one focused
test file, and three governance artifacts.

## What changed

- Rebuilt `HudManaBar` with the shared beveled panel, inset stat bar, crisp
  numeric label, and generated mana-drop icon used by the existing pixel HUD.
- Added `HudVitalsLayout` as the source of truth for the bottom-left stack.
  Skill/loot keep their established positions; XP, health, and mana now have
  deterministic 2px gaps and mana retains a 4px canvas-bottom margin.
- Replaced the fixed bottom-left magnification ceiling with a measured,
  neighbor-safe scale. `HudUI` reads the natural vitals and ability-group bounds,
  then caps magnification before the clusters can collide or the vitals can
  escape above the canvas.
- Replaced the old source-text layout assertion with pure geometry tests for
  authored stack gaps and the 960x540 responsive scale contract.

## Runtime observation

- Before, the legacy mana widget was a flat raw rectangle whose padded label
  rendered against and below the bottom edge:
  `files/visual-review/vitals-hud/before/worst-case-combo__1280x720.png`.
- After, the real `ux-snapshot-lab` production `HudUI` mount shows mana as a
  fully contained blue-steel row:
  `files/visual-review/vitals-hud/core/after-core-1280x720.png`.
- The focused 960x540 geometry test uses the responsive desired scale of
  `1280/960`, proves it is capped to `1.07`, and asserts the scaled vitals right
  edge plus the 12px gutter remains left of the ability bar. The same test pins
  every authored row gap and bottom margin.

## Review and validation

- Plan review: `gpt-5.4`, approved with minor refinements.
- Code review: `claude-opus-4.8`, clean in round 1.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-13-polish-vitals-hud.review-ledger.json`.
- `npm run verify:fast` passed.
- `npx vitest run --project unit tests/unit/hud-ui-layout.test.ts` passed (2/2).
- `npm run scope`: `gameplay_safe=false`; no discretionary heavy gameplay run
  was needed because this changes rendering geometry only.

## Scope notes

The broader probe/tooling/loot/skill experiment was removed before landing.
This PR intentionally excludes `HudAbilityBar`, visual-review tooling, lab
fixtures, capture scripts, and E2E probe infrastructure. The final branch is
hard-capped at ten changed files including governance.
