# ADR: Floor 2 AI objective completion plumbing

## Status

Accepted

## Date

2026-07-05

## Estimated Complexity

🍎 x 3 — cross-cutting gameplay+AI+headless wiring with deterministic regression coverage.

## Context

Floor 2 AI runs were not reliably completable in headless simulation because den-unlock progression and boss-defeat objective plumbing broke across system boundaries:

- Objective progress depended on component state that may already be removed when objective processing runs.
- Floor 2 den progression could be undercounted or replay-counted from persistent `combatEvents`.
- AI objective routing stalled after partial den progress instead of deterministically continuing objective pursuit.

The user requirement was explicit: fix root causes (not seed-specific cheats), preserve determinism, and keep Floor 1 behavior intact.

## Decision

1. Keep Floor 2 objective completion driven by real runtime signals (`combatEvents` + quest counters), but process each death event exactly once per world tick lifecycle.
2. Snapshot Floor 2 family metadata (`familyIndex`, `isBoss`) into death combat events at emission time in `dropSystem` and prefer event metadata in `floor2ObjectiveTick`; fall back to component reads only when present.
3. Guard Floor 2 objective accounting against non-family/no-membership deaths to avoid typed-array default-zero misclassification.
4. Preserve existing Floor 2 AI objective routing shape while tightening quest/boss pursuit and keeping Floor 1 progress behavior as fallback.
5. Add deterministic regression coverage for:
   - one-time death-event processing,
   - component-removed-before-objective-tick correctness,
   - missing-family-metadata safety,
   - real Floor 2 headless completion path.

## Consequences

### Positive

- Floor 2 objective progression is now tied to deterministic, replay-safe combat-event semantics.
- Boss defeat and den unlock latches no longer depend on fragile timing of membership-component removal.
- Floor 1 logic remains unchanged; Floor 2 logic is explicit and test-covered.

### Negative

- `CombatEvent` schema grows two optional fields used by Floor 2 objective processing.
- Headless Floor 2 completion test remains slower than unit/integration tests due to real-run simulation.

### Risks

- Future producers of death events must keep family metadata semantics aligned with `FamilyMembership` for Floor 2 objective consumers.
- If additional Floor 2 objective kinds are enabled from archetype data, AI routing will need corresponding objective handlers.

## Alternatives Considered

- **Rely only on live component reads in objective tick.** Rejected: fails when membership is removed before objective processing.
- **Drive Floor 2 completion from synthetic test hooks instead of runtime events.** Rejected: hides real runtime ordering issues and violates “observe before done.”
- **Lower requirements by tuning only passing seeds or reducing objective scope.** Rejected per explicit user requirement and project policy.
