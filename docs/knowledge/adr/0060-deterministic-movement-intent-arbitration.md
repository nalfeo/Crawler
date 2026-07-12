# ADR 0060: Deterministic movement-intent arbitration

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

🍎 x 5 — introduces a new deterministic AI movement-arbitration foundation, a navigation-commitment clock model, exhaustive unit coverage, and supersedes part of an existing AI priority ADR.

## Context

- **CTX-001**: The current behavior-tree movement stack contains several independently-authored movement authorities: retreat, arena lock-in, interaction, safe-room egress, and progression. A static priority ladder can pick an initial winner, but it does not encode which retained movement owner may be interrupted by which challenger.
- **CTX-002**: Safe-room egress needs lease semantics that differ from simple priority. Once egress owns movement, critical HP is not enough to steal control; egress remains dominant until it clears, except for immediate same-safe interaction or a real physical cage outside safe space.
- **CTX-003**: ADR 0045 made arena lock-in a higher-priority behavior-tree slot and correctly preserved the pure lock-in detector plus the outside-safe Retreat-over-Arena rule. Its static priority-ladder authority section is now too coarse for safe-room egress and other retained-intent cases.
- **CTX-004**: The AI runner must remain deterministic, pure at the decision-foundation layer, independent of Phaser, and suitable for later integration into `bt-ai-provider.ts` without constructing provider-specific `AIDecision` objects.

## Decision

- **DEC-001**: Build a custom pure TypeScript foundation for movement-intent arbitration instead of adopting a state-machine, behavior-tree, or planning library. The foundation is data-only, has no dependencies, reads no wall clock, and performs deterministic sorting and explicit pairwise preemption.
- **DEC-002**: Centralize acquisition priorities for the approved owners: retreat 600, arena lock-in 500, immediate interaction 400, interaction approach 350, safe-room egress 300, and progression 200. These priorities decide only acquisition and tie-break ordering; retained preemption must pass an explicit pairwise rule.
- **DEC-003**: Add a navigation-commitment model with two clocks. The clear-window clock advances on deterministic frames where its owner-independent clear condition is true and resets when that condition is false. The motion-progress clock advances only while the retained owner owns movement; loss of ownership freezes best-so-far distance and no-progress frames without resetting them.
- **DEC-004**: Supersede the static priority-ladder authority portion of ADR 0045. ADR 0045 remains authoritative for the arena lock-in detector and for outside-safe Retreat-over-Arena semantics. ADR 0060 becomes authoritative for retained movement-intent arbitration and safe-room egress preemption.
- **DEC-005**: Encode safe-room egress as an explicit pairwise lease rule: retained egress cannot be preempted by retreat, progression, or interaction approach; immediate interaction can preempt only while the player is inside safe space; arena lock-in can preempt only when a physical lock cages the player outside safe space.
- **DEC-006**: Keep active egress ownership only through a two-frame consecutive outside-safe debounce. The superseded provider's 30-frame waypoint latch was non-owning outside safe space; carrying that duration into an exclusive movement lease materially regressed the 600-run win rate by steering through outside combat. Two frames reject a one-frame room-mouth classification flicker while handing normal combat movement back immediately afterward.

## Consequences

### Positive

- **POS-001**: Provider integration can propose movement intents from existing behavior-tree branches without each branch knowing every other branch's special case.
- **POS-002**: Safe-room egress becomes stable under low-health pressure, avoiding critical-HP retreat oscillation while still allowing immediate in-room interactions and real outside-safe cages to take control.
- **POS-003**: Deterministic tie-breaks make replay debugging practical: priority desc, declaration ordinal, owner/key, and target fingerprint fully order all eligible proposals.
- **POS-004**: The pure foundation is unit-testable without ECS, Phaser, or headless-runner fixtures.

### Negative

- **NEG-001**: Intent producers must supply explicit facts: zone, target relation, target validity, physical lock, and navigation facts. Missing facts are rejected or throw validation errors instead of silently defaulting.
- **NEG-002**: Retained preemption now requires maintaining a pairwise matrix, so new movement owners must be deliberately added to the matrix rather than relying on priority alone.

### Risks

- **RSK-001**: A later provider integration could accidentally keep legacy priority-ladder checks in parallel with the arbiter. Integration should route ownership changes through this foundation and use legacy branches only as proposal producers.
- **RSK-002**: Overly broad physical-lock facts would let arena lock-in steal egress too often. The fact must remain tied to ADR 0045's barrier-verified detector.
- **RSK-003**: Navigation-commitment thresholds are policy values supplied by callers; poor thresholds can cause premature release or excessive retention even though the clock mechanics are deterministic.

## Alternatives Considered

### Buy a finite-state-machine library

- **ALT-001**: **Description**: Model movement ownership as states and transitions using an off-the-shelf state-machine package.
- **ALT-002**: **Rejection Reason**: The problem is not generic state dispatch; it is deterministic proposal selection with target fingerprints, per-proposal facts, and pairwise retained preemption. A library would add dependency and integration surface without removing the custom game-specific matrix.

### Buy a planning or utility-AI framework

- **ALT-003**: **Description**: Replace the behavior-tree movement ladder with a GOAP, utility AI, or planner package.
- **ALT-004**: **Rejection Reason**: This foundation must preserve existing BT proposal logic and only arbitrate approved movement intents. A planner would be larger than the requested pure slice, harder to keep byte-replay deterministic, and risky for the 90% Floor-1 win-rate target.

### Keep ADR 0045's static priority ladder

- **ALT-005**: **Description**: Continue resolving movement by the existing priority slot ordering: retreat, arena, interaction, progression, safe-room egress, and fallback behaviors.
- **ALT-006**: **Rejection Reason**: Static priority cannot express retained egress semantics. It would allow critical-HP retreat to steal movement from safe-room egress, violating the approved behavior that egress wins until cleared unless immediate interaction or a real outside-safe physical cage applies.

### Encode special cases directly in `bt-ai-provider.ts`

- **ALT-007**: **Description**: Add ad hoc `if` checks around the provider's existing behavior-tree decisions.
- **ALT-008**: **Rejection Reason**: That preserves hidden coupling and makes exhaustive pairwise tests difficult. The approved foundation needs pure data objects that can be tested independently and integrated later without touching provider state.
