# Handoff: Guarantee Floor 2 Quartermaster Placement

**Date:** 2026-07-18
**Session slug:** floor2-guarantee-quartermaster-placement
**Apple estimate / actual:** 3🍎 / 3🍎
**Issue:** nalfeo/Crawler#1288
**PR:** stacked on `nalfeo-floor-2-equipment-contracts`

## Systems touched

floor2-settlement

## Summary

Guaranteed that every Floor 2 settlement contains exactly one Quartermaster NPC,
in addition to 1–2 seeded non-Quartermaster shops selected from the random pool.
The Quartermaster is now a structurally separate fixture — removed from the random
candidate pool so it can never be duplicated — and is always placed before the
random shops in the placement plan.

## Key decisions

- **Separate `quartermasterShop` field** on `Floor2SettlementSnapshot` (not merged
  into `shops[]`) so callers get an explicit guarantee rather than having to scan
  the array.
- **`settlementRng` for QM inventory**, not `world.rng`. Inserting QM inventory
  rolls into `world.rng` before non-QM shop rolls would shift all downstream RNG
  consumers. The derived `settlementRng` (`hashStringToSeed('floor2-settlement:' +
world.seed)`) is isolated.
- **`buildSettlementPlacementPlan` param `includeQuartermaster: boolean`** — QM
  placement entry inserted before shops, preferring `shopRoomIds` (non-bar rooms)
  then falling back to all settlement rooms.
- **Empty random-pool guard** — throws an actionable error if `options.archetypes`
  contains only the Quartermaster (e.g. a badly-configured manifest).
- **Lab RNG alignment** — `floor2-settlement-lab` now derives `settlementRng` from
  `hashStringToSeed('floor2-settlement:' + state.seed)` and pre-advances it by
  `1 + 3 + state.shopCount` draws (matching the real implementation's placement
  draw count) before rolling QM inventory.

## Files touched

| File                                                                                                   | What changed                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/floor-types.ts`                                                                            | Added `quartermasterShop: Floor2ShopInstance` to `Floor2SettlementSnapshot`; updated `shops` comment                                                                                                                             |
| `src/game/floor2Settlement.ts`                                                                         | Exported `QUARTERMASTER_ARCHETYPE_ID`; separated QM from random pool; added `includeQuartermaster` param to `buildSettlementPlacementPlan`; placed QM NPC via `settlementRng`; empty-pool guard; `quartermasterShop` in snapshot |
| `src/labs/floor2-settlement-lab/index.ts`                                                              | Imported `hashStringToSeed`; aligned QM inventory RNG with real implementation                                                                                                                                                   |
| `tests/integration/floor2-settlement-broker.test.ts`                                                   | 6 tests: guarantee, idempotency, determinism, pool-exclusion, NPC spacing, empty-pool error                                                                                                                                      |
| `docs/knowledge/review-ledgers/2026-07-18-floor2-guarantee-quartermaster-placement.review-ledger.json` | Valid 3🍎 ledger (plan_review + code_review)                                                                                                                                                                                     |

## Verification run

- `npm run typecheck` — clean
- `npx vitest run tests/integration/floor2-settlement-broker.test.ts` — 6/6 pass
- `npm run verify:fast` — ✅ Fast verification passed

## Review harness

3🍎 → plan review + code review loop (2 rounds):

- **Plan review** (gpt-5.4): 2 concerns found, 2 resolved (RNG isolation, empty pool guard).
- **Code review R1** (claude-sonnet-4.6): 1 concern (lab RNG divergence), resolved in R2.
- **Code review R2** (claude-sonnet-4.6): clean.
- Ledger validated: ✅

## Unresolved issues

None. Ready for stacked PR.

## Recommended next steps

- Verify `quartermasterShop` is consumed by downstream equipment-contract systems
  (A2/A3 epic milestones) when shop inventory generation is wired in.
- Observe in real Floor 2 game (`npm run dev`, enter settlement) to confirm QM NPC
  appears — blocked until A0/A0.1/A1 (Floor 2 bootstrap) land.
