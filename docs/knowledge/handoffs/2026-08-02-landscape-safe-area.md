# Handoff — landscape-only mobile safe-area layout

## Systems touched

hud-ui, input-controls

## Summary

Target device: iPhone 13 Pro, landscape only (2532 × 1170 physical = 844 × 390
CSS px @ DPR 3). Scope excluded touch movement controls — the existing
`createInputCapture` drag/tap scheme was confirmed working and left alone.

- `src/engine/safe-area.ts` (new): converts viewport-relative CSS safe-area
  insets into **design-space** insets. `computeDesignSafeInsets()` is pure and
  intersects each viewport-edge unsafe band with the actual canvas rect, then
  scales the surviving overlap by `design / displayed`. `getSafeAreaInsets(scene)`
  reads the live canvas rect + CSS vars; `onSafeAreaChange(scene, cb)` subscribes
  to the Phaser `'resize'` event (string literal, keeping the module
  runtime-Phaser-free like `ui-scale.ts`).
- `index.html` / `lab.html`: `viewport-fit=cover` and `:root` re-publishes
  `env(safe-area-inset-*)` into `--crawler-safe-area-inset-*`. Desktop Chromium
  always reports `env()` as 0, so republishing gives the e2e gate an override
  point while the real device values flow through the same single code path.
- `index.html` also gained `#rotate-notice`, a portrait interstitial gated on
  `@media (orientation: portrait) and (pointer: coarse)` that hides
  `#game-container`. Web content cannot lock orientation on iOS.
- Insets applied to: the four `HudUI` corner groups, `ModalPickerUI` (safe-rect
  centring + `safeMargin()` fit), `DialogueBox` bottom anchor, and
  `MainGameScene`'s interaction hint + mobile corner buttons.
- `tests/e2e/mobile-hit-targets.test.ts` retargeted from portrait+landscape to
  `landscape-iphone-13-pro` (844 × 390) and `landscape-compact` (667 × 375).

## Validation

Observed in the **real** artifact: `main-scene-probe-lab` boots the actual
`MainGameScene` via `createFloor1GameConfig` + `createFloor1MainSceneOptions`,
not a synthetic lab scene.

Measured geometry at 844 × 390 CSS px: the 16:9 canvas letterboxes to
`693.33 × 390` at `x = 75`, so the 47 px notch bands fall entirely in the
pillarbox and cost nothing. The 21 px home-indicator band covers the full canvas
bottom → design-space insets `{top: 0, right: 0, bottom: 38.77, left: 0}`, safe
bottom boundary `720 − 38.77 = 681.23`.

Before → after (design px, bottom edge):

| Surface                  | Before   | After  | Safe boundary |
| ------------------------ | -------- | ------ | ------------- |
| Loadout modal panel      | 703.50 ✗ | 647.19 | 681.23        |
| HUD `bottomCenter` group | 646.00   | 607.23 | 681.23        |

- `tests/unit/safe-area.test.ts` — 9 cases pinning the pure inset math.
- `tests/e2e/landscape-safe-area.test.ts` — 6 deterministic tests at
  844 × 390 @ DPR 3: in-game HUD, modal, a zero-inset baseline comparison, plus
  three portrait-interstitial cases (portrait touch → shown, landscape touch →
  hidden, narrow **desktop** fine-pointer window → hidden).
- `npm run verify:fast` green (138 files / 2222 tests).

## Unresolved issues

- **`resolveNavigationHudLayout` was deliberately not modified.** It anchors the
  radar/quest tracker to the top/right edges. On the target device the top inset
  is 0 and the right inset is absorbed by the pillarbox, so there is no live
  defect — but a device with a genuine top inset over the canvas would clip
  them. Adding a third parameter breaks `tests/unit/hud-minimap.test.ts:149`,
  which asserts the literal call source string; that test must be updated first.
- **`HudAbilityBar.getPanelScreenBounds()` returns untransformed local/design
  constants**, not parent-transformed world bounds, so it reported a lower edge
  _below_ its own parent container. It is excluded from the safe-area probe
  surface list (the parent `bottomCenter` group covers it). The same caveat
  likely applies to `getAbilitySlotBounds`. Not fixed here — out of scope.
- The ~150 px of pillarbox (~18 % of screen width) is unreclaimed. Widening the
  camera is a Game Designer / balance decision, not a UX one.

## Gotchas for the next agent

- **Inject safe-area insets BEFORE boot in tests.** Adding a stylesheet after the
  scene boots does not change the canvas size, so Phaser never emits `RESIZE`,
  so neither `onSafeAreaChange` nor `ModalPickerUI`'s resize handler fires and
  the layout stays stale. The gate uses `page.addInitScript`. Real device
  rotation _does_ resize the canvas, so the live path is unaffected.
- **A "nothing intrudes" assertion alone is vacuous** — several HUD surfaces
  already sat above 681 px, so the gate would pass with the wiring deleted. The
  suite boots a second zero-inset page and asserts `bottomCenter` moved up by
  exactly `insets.bottom`.
- **Do not assert on `lowestEdge()`** across all probed surfaces: the bottom-most
  surface at this viewport is the _top_-anchored quest tracker, which bottom
  insets cannot move. Assert on the named `bottomCenter` container.
- `return promise` inside a `try`/`finally` runs the `finally` before the promise
  settles — that closed the Playwright context out from under an in-flight
  `page.evaluate`. `await` first.
- `npm ci` fails in this environment: 19 `package-lock.json` entries resolve to
  the blocked `ms-feed-*.pkgs.visualstudio.com`. Workaround is to sed-rewrite the
  host to `registry.npmjs.org`, `npm ci --prefer-offline`, then restore the
  lockfile from a backup. **Never commit the rewritten lockfile.**
