# Handoff — Prop Lab Canvas Fix

**Date:** 2026-06-28
**Session branch:** `nalfeo-fix-prop-lab`
**Persona:** Producer

---

## Systems touched

devtools

## Problem

`prop-lab` shipped broken — it rendered nothing. It checked into the props-system PR
without ever working.

## Root Cause

The lab runner (`src/labs/lab-runner.ts`) calls `lab.create(canvas, controls)` passing
the `#lab-canvas` element, which is a **`<div>`** (see `lab.html:222`). prop-lab cast that
div to `HTMLCanvasElement` and bailed:

```ts
const canvas = canvasEl as unknown as HTMLCanvasElement;
if (!(canvas instanceof HTMLCanvasElement)) {
  canvasEl.textContent = 'prop-lab requires a <canvas> element';
  return; // <-- always hit; lab does nothing
}
```

It also created its own `new GUI({ container: controlsEl })` instead of reusing the
runner-provided lil-gui, which would have produced a duplicate controls panel.

## Fix (1 file, 9/9 lines)

Matched the established `map-gen-lab` pattern:

- Create a real `<canvas>` via `document.createElement('canvas')` and append it to the host.
- Reuse the runner GUI from `controlsEl.__labGui` instead of constructing a second one.
- Cleanup removes the canvas (runner owns GUI teardown).

## Verification

- `npm run verify:fast` → pass (typecheck + lint).
- Observed in `npm run lab` (`?lab=prop-lab`): canvas 640×480, terrain + purple cave overlay,
  amber prop dots, a light-radius glow, boss-stair room, single controls panel, zero console
  errors. Before: only "prop-lab requires a <canvas> element". Screenshot:
  `files/prop-lab-after.png`.

## Known unrelated failures

`tests/headless/floor1-completion.test.ts` wall-time perf guards (30s budget) fail on this
Windows worktree at 42–59s. Machine-bound, not from this dev-only lab change; completion
gates pass. CI hardware holds the budget.

## Apple Metrics

Estimated 🍎 · Actual 🍎 · exact.
