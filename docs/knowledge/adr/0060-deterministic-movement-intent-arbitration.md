# ADR 0060: Deterministic movement-intent arbitration

## Status

Accepted (amended 2026-07-12)

## Date

2026-07-11 (amended 2026-07-12)

## Estimated Complexity

🍎 x 5 — foundational arbitration + provider integration + deterministic headless comparators.

## Context

- Floor-1 movement had multiple competing authorities (Retreat, ArenaLockin, interaction, SafeRoomEgress, Progression) with partial priority rules and hidden coupling.
- The previously attempted yielded/post-selector model split “execution owner” from “latched owner” and introduced `pendingMovementIntentProposal`/temporary execution semantics that were hard to reason about and failed the approved comparator behaviors.
- Safe-room egress needs deterministic, geometry-backed completion (legal origin-boundary cross + outside margin), not sticky latch heuristics.
- The foundation must stay pure/deterministic and reusable by `bt-ai-provider.ts` without provider-private ownership clocks.

## Decision

- **DEC-001**: Keep a pure custom TypeScript arbitration foundation (`movement-intent-arbiter.ts` + `navigation-commitment.ts`), no runtime library dependency.
- **DEC-002**: Acquisition priorities are fixed and global: Retreat 600, ArenaLockin 500, InteractionImmediate 400, InteractionApproach 350, SafeRoomEgress 300, Progression 200.
- **DEC-003**: Arbiter state owns exactly one active lease plus one navigation commitment. Remove pending proposals, temporary migrated-intent execution, yielded latch state, and owner-vs-latch split telemetry.
- **DEC-004**: All migrated owners generate proposals every poll in a side-effect-free phase, independent of tree winner ordering. Arbiter resolves among eligible proposals deterministically. Only the selected proposal’s deferred effect is applied, exactly once.
- **DEC-005**: Pairwise retained-preemption contract is explicit:
  - retained SafeRoomEgress rejects Retreat, Progression, and InteractionApproach;
  - InteractionImmediate may preempt egress only while inside safe space;
  - ArenaLockin may preempt egress only outside safe with verified physical lock;
  - retained ArenaLockin yields only to outside-safe Retreat.
- **DEC-006**: Completion handoff semantics are release → acquire in the same resolution when commitment releases (`acquiredAfterCommitmentRelease`), never illegal preemption for egress→Retreat/Progression.
- **DEC-007**: `NavigationCommitment` remains owner-agnostic and two-clock:
  - owner-motion no-progress advances only while movement ownership is active;
  - clear-window clock advances on owner-independent clear condition while latched.
- **DEC-008**: SafeRoomEgress uses an episode + geometry certificate:
  - capture stable origin safe-room tile set and stable waypoint when episode starts;
  - complete only after legal origin-boundary crossing plus outside margin;
  - re-entry before completion keeps/reseeds same episode;
  - re-entry after completion starts a new episode.
- **DEC-009**: Telemetry records one lifecycle owner stream plus bounded proposal counts/digests (`proposalCount`, `eligibleProposalCount`, order-independent digests).
- **DEC-010**: This ADR supersedes:
  - ADR 0045’s static movement-priority authority section for retained movement arbitration;
  - the earlier ADR 0060 yielded/post-selector DEC branch (latched yielding + temporary executor split), now explicitly rejected.

## Consequences

### Positive

- Deterministic, permutation-invariant arbitration with explicit pairwise rules.
- No losing-proposal state mutation; producer effects are committed only on selection.
- Safe-room egress completion is geometry-evidenced instead of sticky timing heuristics.
- Headless telemetry is simpler (single owner lifecycle) while adding proposal diagnostics.

### Negative

- Producer code must maintain data-only proposal/facts/effect separation.
- More explicit fact plumbing (zone, target relation, domain availability, physical lock, validity).
- Additional test surface for episode/certificate edge cases.

### Risks

- Overly strict legal-step checks can delay egress completion; too-loose checks risk false certification.
- Stale target caches must be revalidated every poll for entity-backed targets.
- Future producers must not reintroduce side effects into proposal generation.

## Alternatives Considered

### Keep static priority ladder only

Rejected — cannot encode retained-owner pairwise semantics or deterministic completion handoff.

### Keep yielded/post-selector pseudo-arbitration

Rejected — split ownership semantics (`yielded` + temporary execution) caused fragile behavior and failed approved Alternative A criteria.

### Adopt FSM/planner library

Rejected — adds dependency/integration cost without replacing game-specific deterministic ranking + pairwise preemption contract.
