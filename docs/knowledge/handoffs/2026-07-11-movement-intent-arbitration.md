# Session Handoff: Floor 1 movement-intent arbitration

## Date

2026-07-11 (updated 2026-07-12)

## Persona

Producer -> Systems Engineer -> QA Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance, quests, ci-policy

## Apples

5 apples estimated, 5 apples actual. Full record:
`docs/knowledge/metrics/apples/2026-07-13-movement-intent-arbitration.json`.

## Outcome

Implemented the human-approved Alternative A redesign:

- all migrated movement owners generate data-only proposals every poll;
- the arbiter owns exactly one active lease and one `NavigationCommitment`;
- only the selected proposal commits its deferred provider effect;
- no `pendingMovementIntentProposal`, temporary migrated executor, sticky
  yielded lease, or execution-owner/latch-owner split remains;
- SafeRoomEgress owns a stable origin-room episode and waypoint until an
  observed legal boundary crossing plus exterior margin completes it;
- completion releases egress and acquires the best eligible challenger in the
  same resolution with a fresh commitment;
- immediate same-safe-space interaction can preempt egress, while retained
  egress still rejects newly arriving Retreat, Progression, and approach-only
  interaction challengers.

The original yielded/post-selector implementation was tested in three 600-run
cloud candidates and rejected (524, 523, and 532 official wins respectively).
ADR 0060 now records that design fork and supersession.

## Stable consumer contract

- `src/game/ai/movement-intent-arbiter.ts` owns proposal ranking, pairwise
  preemption, one active lease, and same-resolution handoff.
- `src/game/ai/navigation-commitment.ts` owns stable target identity,
  validity/arrival, quantized best-so-far progress, owner-motion no-progress,
  and owner-independent clear-window state.
- Consumers provide immutable proposal eligibility, target, commitment facts,
  and execution payloads. They do not persist parallel progress counters.
- Motion no-progress advances only while the lease owns movement. The
  owner-independent clear condition advances whenever its commitment is
  active.
- Retreat remains priority 600 and is eligible in either zone. This preserves
  critical-health retreat when the player reaches a safe room without changing
  the explicit rule that an already-retained egress lease rejects a new Retreat
  challenger.
- Future Retreat and route slices must consume these modules directly; no
  provider-private or safe-room-specific ownership primitive is allowed.

## Validation

Green deterministic checks:

- `tests/unit/ai/navigation-commitment.test.ts`
- `tests/unit/ai/movement-intent-arbiter.test.ts`
- `tests/unit/ai/safe-room-egress-certificate.test.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/headless/floor1-movement-intent-arbitration.test.ts`
- `npm run verify:fast`

The approved ten-row local panel initially produced 8/10 official wins with
zero movement-intent violations:

| Case              | Result | Game time | Safe-room time |
| ----------------- | ------ | --------: | -------------: |
| bow 74            | win    |    265.0s |          19.6s |
| pistol 74         | win    |    271.0s |          28.5s |
| throwing-knife 49 | win    |    232.1s |          25.2s |
| pistol 28         | win    |    289.5s |          14.5s |
| throwing-knife 28 | win    |    290.3s |          12.8s |
| bow 79            | win    |    250.0s |          10.1s |
| pistol 79         | death  |     92.2s |          19.0s |
| throwing-knife 79 | death  |     41.5s |           4.5s |
| fireball 79       | win    |    235.2s |           9.2s |
| throwing-knife 91 | win    |    278.0s |          11.8s |

Artifact-only tracing found the shared seed-79 regression: Retreat proposals
were incorrectly `outsideSafe`, so entering safety invalidated a critical-HP
Retreat lease and let egress eject the player. Retreat is now zone-neutral and
its losing proposal path no longer mutates Retreat state. Provider regression
tests and `verify:fast` are green after the fix. The local ten-run budget was
not exceeded; final falsification is delegated to the required GitHub sweep.

The 5-apple review ledger is valid after:

- an adversarial plan review (`claude-opus-4.8`);
- two code-review rounds (`claude-sonnet-5`);
- independent review by `gpt-5.4` and `gemini-3.1-pro-preview`;
- adjudication and fixes for stale migrated-winner debug telemetry and one
  invalid TypeScript test cast.

## Required cloud gate

Before opening the dedicated PR, dispatch the six-shard 600-run workflow on
this branch and require all of:

- at least 556/600 official wins;
- at most 11 rows with more than 60 seconds of safe-room dwell;
- zero new more-than-60-second safe-room flags among baseline official wins;
- bow seed 97 timeout eliminated;
- the original seven rows preserve legal quest, door, and interaction
  progression;
- unchanged 360-second official-win requirement.

## Boundaries

- No teleport, through-wall interaction, official-time reduction, threshold
  tuning, or weapon tuning.
- General Retreat/kiting remains a dependent slice and stays blocked until this
  PR merges.
- Final travel and general route efficiency remain separate work.

## Pending

- Run PR prerequisites and commit/push this branch.
- Dispatch and evaluate the GitHub-only 600-run gate.
- Open the dedicated unmerged PR only if every hard gate passes.
