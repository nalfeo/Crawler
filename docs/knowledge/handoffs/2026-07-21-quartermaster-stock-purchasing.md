# Handoff: Floor 2 Quartermaster stock and purchasing

## Date

2026-07-21

## Persona

Producer coordination with Systems Engineer implementation and independent Reviewer passes.

## Systems touched

inventory

## Apples

4 apples estimated, 4 apples actual. The change spans deterministic content generation,
world-owned identity and stock lifecycle, an atomic transaction boundary, shared UI/AI
read data, runtime wiring, and unit/property/integration/headless coverage.

## Summary

- Added deterministic Floor 2 Quartermaster stock containing 3-4 level-appropriate
  common/uncommon generated wearable equipment instances.
- Isolated stock generation behind an epoch-derived `SeededRandom`, preserving the
  existing world RNG stream and rarity budgets.
- Added a shared offer projection for UI and AI consumers with affordability, capacity,
  purchase eligibility/failure, price, identity, slots, stats, weight, level, rarity,
  and enhancement data.
- Added one atomic purchase API that validates stock/offer identity, exact quantity,
  availability, inventory existence/capacity, funds, registry identity, retired state,
  and unique physical ownership before committing any writes.
- Successful purchases transfer the exact registry-backed instance reference, debit the
  exact price, and mark the offer sold out. Duplicate attempts fail without mutation.
- Added monotonic restock epochs. Current-epoch repeats are idempotent, skipped or
  backward epochs fail explicitly, and unsold prior instances are retired.
- Reused the guaranteed Quartermaster settlement placement and generated-equipment
  registry. No sprite, asset, Azure, queue, workflow, label, or asset-PR surface changed.

## Runtime evidence

The real `runHeadless(..., { floorId: "floor2", maxFrames: 1 })` pipeline was exercised
for stressed seeds 6 and 1 through `tests/headless/floor2-completion.test.ts`.

- Both runs booted exactly one Quartermaster and the expected settlement topology.
- Each run created 3-4 generated offers.
- Every offer identity resolved to an instance in the world registry.
- Every offer was common or uncommon, with both rarities represented.

The Floor 2 settlement integration test also purchased a generated offer through the
authoritative API and observed the exact same registry instance in the player's bag.

## Validation

- Targeted unit/property tests: 16 passed.
- Floor 2 settlement integration tests: 8 passed.
- Floor 2 headless pipeline tests: 6 passed.
- `npm run verify:fast`: passed.
- Review ledger validation: passed.

## Review

- Adversarial plan review (`gpt-5.4`): 10 concerns resolved with minor divergence;
  three alternatives were considered.
- Code review (`claude-sonnet-4.6`): final implementation clean after two rounds.
- Multi-model review (`gpt-5.3-codex`, `gemini-3.1-pro-preview`) adjudicated by
  `gpt-5.4`: one retirement-state concern was rejected because the retired identity set
  protects against corrupted current stock reusing a registry-backed prior instance.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-21-quartermaster-stock-purchasing.review-ledger.json`
- Architecture decision:
  `docs/knowledge/adr/0067-quartermaster-stock-ownership-and-atomic-purchasing.md`

## Follow-up

Publish a ready PR against `main`, arm squash auto-merge, shepherd CI/review findings,
and report the PR number, final head SHA, and verified merge SHA to the parent session.
