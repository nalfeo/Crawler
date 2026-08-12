# Session Handoff: Real-Game Random Seed

## Date

2026-07-11

## Persona(s) adopted

- UX Designer

## Routing verdict

✅ right persona — this change is isolated to the player-facing game launch boundary.

## Apples

Estimated: 🍎🍎
Actual: 🍎🍎
Verdict: 🎯 Exact

## Systems touched

mapgen

## Summary

Real-game launches now generate a fresh seed from browser crypto entropy when the URL
does not provide one. A valid `?seed=<integer>` remains an explicit deterministic override,
and internal world creation still defaults to seed `42`.

## Files touched

- `src/bootstrap/game-launch-seed.ts`
- `src/main.ts`
- `tests/unit/game-launch-seed.test.ts`

## Verification

- Baseline `npm run verify` reached PR prerequisites; the expected missing-handoff check failed.
- `npm run verify:fast` ✅
- Focused unit tests: 4 passed ✅
- `VERIFY_FULL=1 npm run verify` (including 92 headless tests and production build) ✅
- `npm run security:check` and `scripts/agent/lab-gate-check.sh` ✅
- Real game at `http://127.0.0.1:4173/`: consecutive launches used seeds `977980` and
  `867602`; `?seed=42` used seed `42` ✅

## Unresolved issues

None.

## Recommended next steps

None.
