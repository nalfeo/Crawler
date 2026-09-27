# Session Handoff: Floor 4 Green Room public purchase path

## Date

2026-09-27

## Persona

Producer

## Systems touched

Floor 4 scenario/shop, deterministic AI replay, shared inventory metadata, MainGameScene canvas UI, visual AI-runner diagnostics, regressions.

## What Was Done

Fixed the ordinary Floor 4 Green Room path so the panel and replay choose the same affordable genuine upgrade from the current live build. The comparison includes a direct-start active weapon even when it has no inventory wrapper, and the player-facing panel now states the current weapon DPS alongside candidate data.

Fixed the static-equipment metadata gap that hid valid shop purchases from the integrated Equipment bag. The ordinary visual replay loads the standard Floor 4 scene and seed 404, reaches the Green Room through combat, takes the lab's visible Control button, buys through the sponsor keyboard panel, equips by clicking the visible Gear button and bag cell, returns AI control, then reaches Act 2.

The paired headless replay uses the same seed/input with one explicit public purchase decision versus skip. It asserts one exact spend, final equipped weapon persistence after Act 2, a changed `baseDamage`/`cooldownMs` production tuple, and changed combat damage.

## Verification

- `npm run verify:fast` — passed (277 files, 3515 tests; integrity/coverage checks passed).
- Focused Green Room stock and paired replay tests — passed.
- `tests/e2e/floor4-green-room-ordinary-purchase.deterministic.test.ts --project e2e` — passed.
- TypeScript no-emit — passed.

## Authorizations and Constraints

User authorized implementation, tests, commit, push, and a ready-for-review PR. The path must use shared Floor 4 scenario configuration and ordinary controls; no special floor launch, grants, forced combat, or auto-merge. Authorization transfers to CI Recovery/merge train after publication.

## Next Steps

Run `verify:pr-prereqs` again, sync main, perform the required complete-diff review, publish the ready-for-review PR, attach it, and release ownership. No known gameplay blocker remains.
