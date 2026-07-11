# ADR: Floor 2 settlement progression contract

## Status

Accepted

## Date

2026-07-11

## Estimated Complexity

4 apples - quest wayfinding, deterministic AI, HUD disclosure, and real-pipeline
regression coverage share one progression contract.

## Context

Floor 2 starts with a visible `floor2-find-settlement` quest, a generated
settlement cluster, and a locked family-reputation system. Three consumers had
different interpretations of that state:

- quest waypoints only resolved Floor 1 objective positions, so the tracked
  settlement quest produced no minimap marker or direction arrow;
- the headless behavior tree ignored the settlement quest and immediately
  pursued den-unlock enemies and territories;
- the Families HUD treated the presence of Floor 2 family state as sufficient
  to reveal reputation, even though that state is intentionally locked until
  the Broker introduction completes.

Settlement discovery and Broker introduction are separate milestones. Entering
any settlement-cluster room completes the settlement quest, while talking to the
Broker unlocks the reputation system. Collapsing both milestones into one
Broker target would make the quest marker disagree with its completion rule.

## Decision

1. Floor 2 introduction uses a two-phase critical progression chain:
   - before `floor2-settlement-found`, the primary non-safety goal is a stable
     walkable anchor inside the settlement's primary room;
   - after settlement discovery but before `floor2-broker-intro-complete`, the
     primary non-safety goal is the live Broker interaction anchor, falling back
     to the settlement anchor when the Broker entity is missing or invalid;
   - only after Broker introduction does existing den, boss, and exit
     progression resume.
2. A neutral core helper resolves the settlement anchor from
   `world.floorExtendedState.settlement.settlementRoomId` and the room's
   generated interior cells. Consumers must not query `RoomRole.SETTLEMENT`
   because settlement rooms are retagged `SAFE` during initialization.
3. Quest waypoints resolve Floor 2 goal positions from shared world state
   without importing game-layer modules into core.
4. The behavior tree keeps retreat and collision-avoidance dodge as explicit
   safety overrides. During the two introduction phases it disables unrelated
   opportunistic loot/farm steering and nearby-threat-before-NPC preemption.
   "Primary progression goal" therefore means the highest-priority non-safety
   goal.
5. Families HUD visibility follows the authoritative activation state:
   `familyState` must exist and `reputationSystemActive` must not be explicitly
   false. An omitted activation field remains visible for backwards-compatible
   lab and fixture worlds, while real Floor 2 initialization always supplies
   `false` until the Broker introduction tick.

## Consequences

### Positive

- Quest text, minimap marker, direction arrow, AI routing, and reputation
  disclosure agree on the same Floor 2 progression milestones.
- Missing Broker entities degrade to continued settlement guidance instead of
  silently advancing into den or boss hunting.
- Floor 1 quest waypoints and existing post-introduction Floor 2 progression
  remain unchanged.
- Safety behavior remains available without allowing optional combat or loot to
  replace the progression goal.

### Negative

- The behavior tree gains an explicit Floor 2 introduction predicate in both
  its primary and opportunistic tracks.
- The settlement anchor helper depends on the generated room interior-cell
  contract and must return no target when the settlement snapshot or map is
  absent.

### Risks

- Future Floor 2 introduction steps must extend the critical-chain contract
  rather than adding an independently competing quest or AI target.
- If settlement generation stops providing interior cells, the anchor resolver
  will need a new walkability-aware fallback rather than using a raw room-bounds
  center.

## Alternatives Considered

- Target the Broker from Floor 2 start. Rejected because settlement discovery
  completes on cluster-room entry, not Broker interaction.
- Add a first-class `floor2-meet-broker` quest. Rejected for this focused fix
  because it adds content, save-state, and UI churn beyond the required
  progression repair.
- Store a mutable `floor2CriticalChainPhase` field. Rejected because the two
  existing goal flags already provide deterministic source-of-truth state.
- Resolve settlement by room role. Rejected because initialization retags the
  generated settlement rooms as `SAFE`.
