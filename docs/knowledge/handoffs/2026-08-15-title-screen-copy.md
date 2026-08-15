# Title screen copy

**Date:** 2026-08-15
**Apples:** 1🍎 (declared 1🍎, actual 1🍎)

## Systems touched

hud-ux

## Summary

Changed the boot loading screen and intro/title panel copy from `THE CRAWLER` to `Crawler` so the title screen matches issue #2942's requested wording.

The requested issue plan was posted before code changes as a reply to issue comment `5300799722`.

## Files touched

- `src/engine/scenes/BootScene.ts`
- `src/engine/scenes/IntroScene.ts`
- `tests/unit/title-screen-copy.test.ts`

## Verification

- Before edit real-app observation via Vite dev server + Playwright canvas text probe: rendered `THE CRAWLER`.
- `npm run test:unit -- tests/unit/title-screen-copy.test.ts`
- After edit real-app observation via the same Vite dev server + Playwright canvas text probe: rendered `Crawler`.
- `npm run verify:fast`

## Unresolved issues

None known.

## Recommended next steps

- Let CI run the normal PR gates.
