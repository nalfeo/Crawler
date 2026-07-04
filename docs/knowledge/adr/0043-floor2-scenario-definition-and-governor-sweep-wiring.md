# ADR 0043: Floor 2 scenario-definition and Governor sweep wiring

## Status

Accepted

## Date

2026-07-03

## Context

Floor 2 slices 1–7 landed subsystem pieces (families, cave generator, AI, bosses/dens, settlement/events, HUD), but the runtime still booted only Floor 1. Manifest loading also did not include Floor 2-specific scenario fields, and the Governor sweep script was still a stub.

## Decision

1. Add a scenario-definition registry (`src/game/scenarioDefinitions.ts`) and wire scenario selection through:
   - visual runner (`src/bootstrap/floor-main-scene-options.ts`)
   - headless runner (`src/game/ai/headless-runner.ts` / CLI)
2. Extend floor-manifest schema/loader to include:
   - `map.biome`
   - `floor2.presentCount`
   - `floor2.familyPool`, `floor2.resourcePool`
   - `floor2.settlement.shopCountRange`, optional archetype whitelist
   - `floor2.governor` tuning flags
3. Register and load Floor 2 manifest from the floor registry and use biome-driven generator resolution via `getGenerator(manifest.map.biome)`.
4. Implement Floor 2 scenario initialization in `src/game/floor2Scenario.ts` by composing existing slices:
   - seeded roster selection + faction relation init
   - cave-system map generation
   - boss/den wiring
   - settlement/shop init
   - objective tick registration
5. Replace Governor sweep stub with a deterministic Floor 1 + Floor 2 seed sweep that writes `coverage/balance-metrics.json`.

## Consequences

### Positive

- Floor 2 can now be selected from production scenario wiring.
- Manifest-driven biome/present-count/shop/family/resource config is parsed and consumed.
- Governor sweep produces real win-rate telemetry across both floors.
- Full `npm run verify` (including `VERIFY_FULL=1`) passes on this slice branch.

### Negative

- Floor 2 balance tuning is still early; the governor sweep now reflects real objective flow (easy-mode flags shipped disabled) and may surface additional follow-up tuning work once objective-complete wiring is fully productionised.

### Risks

- Governor convenience flags (`autoUnlockDens`, `autoVictoryOnStart`) are shipped disabled in the Floor 2 manifest; if they are re-enabled unintentionally the Governor gate will report a trivially inflated win-rate.
- The governor sweep telemetry artifact (`docs/knowledge/metrics/floor2-slice8-governor-sweep.json`) was initially captured with easy-mode flags enabled; it should be regenerated after each balance pass to remain accurate.

## Alternatives considered

1. Keep hardcoded Floor 1 wiring and run Floor 2 only via labs (rejected: does not satisfy integration slice).
2. Build a separate ad-hoc Floor 2 runner instead of scenario definitions (rejected: duplicates wiring surface).
3. Keep Governor script as SKIP and rely on manual sweep notes (rejected: non-deterministic and unverifiable).
