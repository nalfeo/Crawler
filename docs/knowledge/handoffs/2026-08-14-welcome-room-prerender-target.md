# Handoff — 2026-08-14 — welcome-room pre-render target

**Session:** welcome-room-prerender-target
**Apples:** 2🍎

## Summary

Turned the lore-grounded `welcome-room-v2` blockout into a deterministic
pre-decomposition target. The target is a native-resolution SVG showing the
three resident activity zones, the exposed shared backstage gap, the
two-tile circulation route from the door, and the broker bookcase as the focal
mass. It intentionally stops before individual prop decomposition.

## Lore guardrails

- The Tutorial Goon is a former contestant who now runs orientation.
- The Sweaty Merchant and Spell Broker are Director-created NPCs.
- The three residents have shared one room for uncountable seasons and cycle
  between lovers, friends, and enemies; the target does not freeze a current
  relationship state.
- The room remains a threadbare commercial-break reception/safe room.

## Files touched

- `src/shared/data/set-piece-evidence/welcome-room-v2.json`
- `src/shared/data/set-piece-evidence/welcome-room-v2-blockout.svg`
- `scripts/agent/set-piece/pilot-evidence.ts`
- `tests/unit/set-piece/pilot-evidence.test.ts`

## Systems touched

mapgen

## Verification

- `npx vitest run --project unit tests/unit/set-piece/pilot-evidence.test.ts`
- `npm run typecheck:src`
- `npm run verify:fast`
- `npm run setpiece:score -- welcome-room-v2` — 12/12 pass after redress
- Real-engine visual review — `files/visual-review/welcome-room-v2-prerender-judge-r3-2026-08-15T05-00-23-629Z.review.json`

## Visual review outcome

The visual judge returned 3/5, advisory `needs-work`. A first pass identified
the broker-side-table/chair cluster as blocking the central route; both were
removed and the real-engine capture was repeated after restarting the lab.
The remaining review findings concern the small baked typography on the
existing banner, desk, and signage sprites. Those are asset-level changes, not
safe blockout adjustments, and remain deferred until the explicitly later prop
decomposition/commission phase.

## Next gate

Review the SVG target and real-engine capture as the composition contract.
Proceed to prop inventory/decomposition only when the sprite-level typography
and signage treatment are in scope.
