# Session Handoff: Floor 1 movement-intent arbitration

## Date

2026-07-11

## Persona

Producer → Systems Engineer → QA Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance, quests, ci-policy

## Apples

5🍎 estimated, 5🍎 actual (exact). Full record:
`docs/knowledge/metrics/apples/2026-07-12-movement-intent-arbitration.json`.

## What Was Done

- Added the pure `navigation-commitment.ts` reducer. It owns stable target
  identity, validity/arrival, quantized best-so-far distance, owner-motion
  no-progress frames, and owner-independent clear-window frames.
- Added the pure `movement-intent-arbiter.ts` lease resolver with centralized
  acquisition priorities and an exhaustive pairwise preemption contract.
- Migrated Retreat, ArenaLockin, immediate/approach interaction,
  SafeRoomEgress, and Progression proposal metadata into the arbiter seam while
  retaining legacy fallback for Engage, Collect, Hunt, and Explore.
- Made SafeRoomEgress the first production NavigationCommitment consumer. Its
  normal clear path requires two consecutive outside-safe frames, rejecting a
  one-frame mouth-boundary flicker before handing off to an eligible challenger
  in the same resolution. An allowed barrier-verified ArenaLockin may still
  preempt on the first outside-safe frame.
- Preserved legal same-safe noncombat objectives and a retained merchant-fetch
  route crossing safe space without allowing enemy-backed Progression to park
  there.
- Added structured movement owner/lifecycle telemetry to headless events and
  run stats, including illegal in-safe Retreat/enemy-Progression counts.
- Added pure reducer/arbiter tests, provider contract tests, telemetry coverage,
  and real-headless official-win comparators for seed 74 bow+pistol and seed 49
  throwing-knife.
- Recorded ADR 0060 and completed the adversarial, two-round, multi-model
  review ledger.

Observed in the real headless pipeline — before: the seven sweep rows spent
roughly 143–351 seconds in safe rooms and timed out; after: five rows are
official wins, seed 48 throwing-knife hands off to an outside-safe Retreat
failure owned by the dependent kiting slice, and seed 76 pistol has zero
merchant-Progression→egress churn, only 30 seconds total safe-room time,
completes the merchant quest, and times out later in boss/combat progression.

## Key Decisions Made

- `NavigationCommitmentState` is the sole persistent owner of generic
  target/progress/no-progress/clear-window facts. Provider payloads and
  intent-private counters do not live in arbiter state.
- Motion no-progress advances only while the intent owns movement. A latched
  owner-independent clear condition advances regardless of temporary movement
  ownership.
- Retained SafeRoomEgress cannot be preempted by Retreat or Progression.
  Immediate interaction may preempt inside safe space; a barrier-verified
  ArenaLockin may preempt outside. ArenaLockin yields only to outside Retreat.
- Preemption initializes the challenger's NavigationCommitment. Reusing the
  retained owner's commitment would make lease owner and navigation target
  diverge.
- Non-selected egress proposals cannot mutate the waypoint latch. This prevents
  an ineligible proposal from becoming eligible one frame later after crossing
  the safe-space boundary.
- Active egress uses a two-frame outside-safe clear window. The old 30-frame
  provider latch was non-owning outside the room; reusing its duration for an
  exclusive lease caused the first cloud gate to fall from 556/600 to 524/600
  by steering normal runs through outside combat.
- The dependent Retreat slice must consume these modules directly and provide
  immutable facts/policy only; it must not create a parallel commitment reducer
  or private progress counters.

## What's Next / Blockers

- Commit and push this branch, dispatch the GitHub 600-run Floor 1 sweep, and
  require at least 556/600 official wins plus no safe-room ownership signature
  regression before opening the dedicated unmerged PR.
- The Retreat/kiting slice remains intentionally blocked until this PR merges.
  It owns seed 48's outside-safe Retreat behavior and must not add a private
  safe-room exception.
- Final travel and general route efficiency remain separate future slices.

## Retrospective

### Lessons Learned

- Ownership telemetry identified the first wrong transition much faster than
  decision-reason parsing.
- Proposal builders must be side-effect-free until selected; eligibility alone
  does not protect against state latched before arbitration.
- The arbiter and commitment reducer need separate target assertions because a
  correct lease owner can still carry the previous owner's reducer state.

### Mistakes Made

- The initial preemption path reused the retained owner's NavigationCommitment
  when installing a challenger. The early signal was a selected egress lease
  whose stored navigation target still named Progression.
- The first cloud implementation conflated a 30-frame non-owning waypoint latch
  with 30 frames of exclusive movement ownership. The source-vs-branch cloud
  artifacts showed 44 lost official wins and only 12 gains, with repeated
  cross-weapon seed flips, before the active clear window was corrected.
- The egress builder initially latched a waypoint before declaring itself
  unavailable. Seed 76 exposed the resulting next-frame Progression↔egress
  oscillation.
- Parallel read-only reviewers shared the worktree and one temporarily edited
  untracked foundation files. The deterministic matrix tests exposed the
  contamination; future review prompts should be backed by isolated diffs or
  enforced read-only worktrees.

### Opportunities for Future Improvement

- Add tooling that snapshots or isolates the working tree before multi-model
  review so a reviewer cannot contaminate another review round.
- Migrate the remaining legacy movement producers only when they need durable
  ownership; avoid speculative expansion of the arbiter surface.
- Promote the seven-row signature classifier into the cloud sweep artifact so
  safe-room dwell, illegal owners, and churn are reported without ad hoc JSONL
  scripts.
