# Session Handoff: Floor 6 foundation and map

## Date

2026-08-31

## Persona

Systems Engineer

## Systems touched

mapgen, scenario-registry, headless-runtime, labs

## Apples

Estimated: 4🍎; actual: 4🍎 — the slice adds a replay-stable authored map contract and shared
windowed/headless scenario initialization across core, shared data, game wiring, and labs.

## Summary

- Registered the unreleased, non-MVP Floor 6 manifest and `ScenarioDefinition`.
- Added a compact RNG-free Broadcast Relay set with two stable routes, five off-route build sites,
  player ingress, Relay, pickup access, sealed break enclosure, and barred victory exit.
- Added the `SETUP` phase skeleton plus isolated `waves`, `routes`, `rewards`, `upgrades`,
  `dressing`, and `bosses` stream-key artifacts.
- Added a parity lab and focused tests for windowed/headless byte equivalence, supported-footprint
  route reachability, site legality/non-blocking occupancy, and registration/release state.
- Added no tower, wave, or floor-scoped economy behavior; later slices retain those responsibilities.

## Verification

- `npm run verify:pr-prereqs` — passed after ADR 0098 was added for the cross-layer decision.
- Independent post-diff review ran the Floor 6 parity test and reported it passing; it also ran
  TypeScript and ESLint checks plus the relevant manifest/registry suites clean.
- A second independent review found the initially isolated break enclosure and a vacuous
  off-lane regression assertion. Both were corrected in `5ec5869` and `477eb94`.
- CI recovery for the Lightweight Checks `check:test-only-exports` blocker renamed
  Floor 6 test/lab-only diagnostic exports with `_` prefixes and removed direct test
  imports of shared point/footprint types.
- `npm run check:test-only-exports`, targeted Floor 6 unit/headless tests,
  `npm run typecheck`, `npm run format:check`, `npm run verify:fast`, and
  `npm run verify:pr-prereqs` passed after that recovery.
- CodeQL reported no alerts, but skipped JavaScript analysis because the database exceeded its
  size limit.

## Runtime observation

- Before: static map review found the break enclosure was an isolated passable island, so neither
  supported footprint could enter it from the production map.
- After: the real generated `BroadcastRelaySetGenerator` map has a fixed pickup-to-break
  connector; the focused footprint traversal checks cover ingress to pickup access, break
  enclosure, and exit, while the shared windowed/headless initialization parity artifact remains
  byte-equivalent.
