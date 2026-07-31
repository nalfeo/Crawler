# Handoff: Floor 2 economy pricing rebalance

## Date

2026-07-30

## Persona

Game Designer

## Systems touched

economy, inventory

## Apples

2🍎 estimated.

## Summary

- Raised `shopPricing.floor2TierMultiplier` from `1.0` to `2.5` in `src/shared/data/tuning.json` so Floor 2 stocked shop prices scale up across all archetypes.
- Updated Quartermaster generated-stock pricing in `src/game/quartermaster-stock.ts` to apply the same `floor2TierMultiplier`, keeping generated offers on the same economy curve as other Floor 2 shops.
- Added focused regression coverage in `tests/game/quartermaster-stock.test.ts` asserting generated-offer unit prices exactly follow:
  - `(20 + itemLevel * 5) * rarityMultiplier * tuning.shopPricing.floor2TierMultiplier`
  - with `rarityMultiplier = 1.0` (common) or `1.5` (uncommon), rounded and clamped to `>= 1`.

## Evidence used

- Broad Floor 1 baseline sweep evidence sourced from existing successful GitHub run `29564772319` (canonical contiguous 1..100 seeds × sword/bow/baseball-bat):
  - `project:sweep-results-viewer runId=29564772319`
  - win-rate: `280/300 = 93.33%`
  - end-of-floor gold distribution (`totalGold`):
    - min `2`, p25 `95`, median `178`, p75 `281`, p90 `308`, max `352`, mean `181.17`
- Floor 2 price-surface audit (before → after):
  - archetype-stocked shops (entry-level unit prices): median `55` → `138`, max `144` → `360`
  - Quartermaster generated offers (typical Floor-1 carryover levels 5–7):
    - common `45–55` → `112–138`
    - uncommon `68–82` → `169–206`

## Validation status

- `npm run verify:fast` **failed in this sandbox** because required node modules are unavailable and dependency install is blocked by network resolution errors (`tsx`/`typescript`/`@eslint/js` not resolvable locally).
- `npx vitest run tests/game/quartermaster-stock.test.ts` also failed for the same missing-dependency reason.
- `parallel_validation` executed; no findings were reported, but local code-review tooling availability is limited in this environment.
- `runtime-tools-secret_scanning` returned a repository lookup error in this environment; changed files were manually checked and contain no secrets.

## Notes / blockers

- Posting the requested pre-code plan comment directly on issue `#2367` and dispatching a fresh workflow run were both blocked in this sandbox due GitHub auth/remote constraints (`origin` mapped to localhost proxy and invalid token state for `gh`).
