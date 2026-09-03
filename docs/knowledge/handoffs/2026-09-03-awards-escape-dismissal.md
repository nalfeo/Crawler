# Handoff: Awards panel Escape dismissal

## Date

2026-09-03

## Persona

Implementer

## Systems touched

hud-ux

## Apples

1 estimated, 1 actual

## Summary

Fixed issue #4138 by giving the Awards panel explicit Escape ownership in
MainGameScene's window-level keyboard handler. Escape now closes Awards without
leaking into interaction or another blocking surface. The panel hint now
documents both supported close inputs, V and Escape; the existing V toggle path
is unchanged.

## Verification

- Before-fix real-stack observation: the focused MainGameScene UI-exclusivity
  test timed out with `achievementsOpen: true` after Escape.
- After-fix real-stack observation: the focused Awards Escape test passed against
  the real main-scene probe artifact.
- `npx vitest run --project e2e tests/e2e/main-game-scene-ui-exclusivity.test.ts`
  passed all 24 tests.
- `bash scripts/agent/verify-fast.sh` passed.
