# Handoff: Deprecate iPhone Orientation Lab Feature

**Date:** 2026-07-10  
**Session slug:** deprecate-iphone-orientation-lab  
**Apple estimate:** 🍎 (1)  
**Actual apples:** 🍎 (1)  
**Verdict:** exact

## Systems touched

docs-tooling

## What was done

Removed the "iPhone orientation" (iPhone landscape viewport simulation) feature from the labs shell. This was a dev-only toggle button that simulated an iPhone landscape viewport (844×390px) in the lab UI.

### Files changed

- **`lab.html`**: Removed `#viewport-toggle` button element, `#viewport-toggle[hidden]` CSS rule, three `body.lab-shell--iphone-landscape` CSS blocks, and the `@media (pointer: coarse)` media query that hid the toggle on touch devices.
- **`src/labs/lab-shell.ts`**: Removed `LabViewportPreset` type, `IPHONE_VIEWPORT_CLASS`, `VIEWPORT_PRESET_KEY` constants, `readViewportPreset()`, `setViewportPresetState()` export, `viewportToggle` from `LabShellElements`, `allowViewportPreset` from `InitLabShellOptions`, and all viewport toggle event handling from `initLabShell()`.
- **`src/labs/lab-runner.ts`**: Removed `getViewportToggle()`, the `globalControlsSection`/`globalControlsHeading` DOM creation, and the code that moved the toggle into the sidebar.
- **`tests/unit/lab-shell.test.ts`**: Removed three iPhone/viewport-related test cases; simplified `createElements()` to omit `viewportToggle`.

## Lessons

- A single-member union type (`'desktop' | nothing`) is a code smell — remove it immediately rather than leaving it for a future cleanup.
- The `verify:fast` run caught no regressions; all 371 test files passed.

## Review ledger

1-apple change, no review stages required per the review-harness policy.
