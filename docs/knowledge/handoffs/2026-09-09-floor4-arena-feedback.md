# Session Handoff: Floor 4 arena feedback validation

## Systems touched

floor4-arena

## Apples

3🍎 estimated, 3🍎 actual (exact). The existing arena, Headliner, and Green
Room transition contracts were validated and the missing authoritative shop
purchase path was added without changing combat balance or phase timing.

## Kickoff

Recommended: the approved plan had a bounded deterministic completion gate,
and the reported arena/Headliner/intermission symptoms were reproducible
against existing telemetry before the remaining shop gap was implemented.

## What was done

- Confirmed the authored Floor 4 geometry and deterministic zero-RNG map path
  already match the manifest and remain traversable.
- Confirmed the production headless pipeline releases all authored waves and
  physically spawns and defeats one Headliner in each of the five acts.
- Confirmed the shared scenario authority holds during intermission, opens and
  retires Green Room visits, and resumes each next act through the public marker
  contract.
- Added `purchaseFloor4GreenRoomOffer`, which validates the active visit,
  offer stock, catalog membership, inventory, and wallet before atomically
  decrementing stock, adding the catalog item, and charging gold.
- Added purchase-count state and deterministic regression coverage for a
  successful purchase and an inactive-visit rejection.

## Real-pipeline evidence

The real `runFloor4(404)` headless artifact passed before and after the change,
including all five acts, waves, Headliners, Green Room intermissions, and
terminal victory. The purchase regression exercises the same run-scoped
Green Room state used by `arenaDirectorSystem`; no runner-only phase shortcut
or balance change was introduced.

## Follow-up lock fix

The Green Room tunnel is now sealed by the shared barrier overlay outside
intermission. After a public Green Room confirmation, sealing waits until the
player has crossed back into the arena, preventing both active-wave retreat and
the transition edge that could trap a player on the shop side. The director
owns barrier lifecycle; no headless-only mutation was added.

## Validation

- `npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts`
- `npx vitest run tests/unit/floor4-green-room-stock.test.ts tests/unit/floor4-arena-director.test.ts tests/unit/floor4-arena-map.test.ts`
- `npm run typecheck`
- `git diff --check`
- `bash scripts/agent/verify-fast.sh`
- `npx vitest run tests/headless/floor4-arena-completion.test.ts` (seed 404
  real-pipeline completion and deterministic replay)
