# ADR 0098: Floor 6 foundation scenario parity

## Status

Accepted

## Date

2026-08-31

## Estimated Complexity

🍎 x 4 — introduces an authored map contract across core geometry, scenario wiring, headless execution, and a parity lab.

## Context

Floor 6 needs a compact, replay-stable production set before later slices add wave, tower, economy, or finale behavior. The windowed game and headless runner must initialize exactly the same semantic geometry and phase artifact without consuming the shared combat RNG. Floor 6 must remain registered for development while excluded from progression and release.

## Decision

Use an authored, RNG-free `BROADCAST_RELAY_SET` map generator with stable semantic identifiers for player ingress, the Broadcast Relay, entrances, route corridors, build sites, pickup access, a connected break enclosure, and the barred victory exit. Store the Floor 6 phase skeleton and purpose-specific stream keys in floor-scoped scenario state, then initialize it exclusively through the existing `ScenarioDefinition` seam shared by `createFloorMainSceneOptions` and the headless runner.

## Consequences

### Positive

- **POS-001**: Windowed and headless initialization serialize the same map and phase artifact for a given seed.
- **POS-002**: Fixed off-route build sites preserve every supported enemy footprint's route to the Relay.
- **POS-003**: Isolated stream keys prevent future content choices from perturbing shared combat RNG.

### Negative

- **NEG-001**: Authored geometry adds a dedicated map-generator and manifest schema instead of reusing a procedural layout.
- **NEG-002**: The foundation intentionally has no playable win path until later Floor 6 slices land.

### Risks

- **RSK-001**: Future topology edits can invalidate route or player-destination reachability; the focused parity and footprint tests must remain authoritative.

## Alternatives Considered

### Reuse the Floor 5 siege map

- **ALT-001**: Use `SIEGE_CASTLE` and reinterpret its landmarks as Floor 6 locations.
- **ALT-002**: Rejected because its opposing siege geography does not provide Floor 6's distinct one-sided Relay-defense semantics or fixed site contract.

### Generate the map procedurally

- **ALT-003**: Roll a new defense layout from the floor seed at initialization.
- **ALT-004**: Rejected because stable route, site, and footprint proofs require a fixed semantic topology, and procedural variation would complicate replay parity without adding behavior in this slice.
