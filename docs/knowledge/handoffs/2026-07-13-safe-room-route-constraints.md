# Session Handoff: Safe-room route constraints

## Date

2026-07-13

## Persona

Producer → Systems/AI Engineer → QA

## Systems touched

ai-pathfinding, ai-behavior-tree, ai-combat-balance, quests, ci-policy

## Apples

5🍎 estimated, 5🍎 actual

## What Was Done

- Replaced semantic `SafeRoomEgress` movement ownership with a pure, reusable
  safe-room route constraint beneath Progression, Retreat, and Interaction.
  Semantic intent and commitment identity now survive intermediate exit
  waypoints; route geometry completes only its own segment.
- Added deterministic commitment selection, canonical path-prefix routing,
  nav-epoch/commitment reseeds, mouth re-entry handling, blocked-door release,
  and a final blocked-motion clamp after fused steering, smoothing, and
  anti-stall processing.
- Added pure, property, provider, and real-headless coverage for adjacent and
  multi-tile crossings, same-space interactions, blocked doors, stable
  waypoints, permutation invariance, commitment persistence, and no
  through-wall/remote effects.
- Persisted route activation/completion/blocked/reseed counters in structured
  simulation events, `RunStats`, local sweep rows, and cloud artifacts.
- Added a dispatchable `safe-room-route` mode to the existing AI sweep workflow:
  exactly six weapons × seeds 1–100, with an immutable `a8e26a51` baseline
  manifest and deterministic 600-run comparator.
- Used the first canonical cloud result (565/600 wins, 4 flags, but three new
  throwing-knife flags) to identify a route lifecycle storm. External semantic
  winner changes now preserve the current legal exit segment, same-room targets
  release immediately, and downstream steering cannot overwrite active route
  locomotion. A follow-up real-headless regression exposed and fixed a nested-A\*
  door-center wedge by routing the existing mover to the legal prefix endpoint
  while retaining the full path as the geometry certificate.
- Observed in the real headless pipeline — before: immutable baseline artifacts
  at `a8e26a51` recorded 556/600 official wins and 11 runs over 60s safe dwell;
  after: the exact approved 10-case local panel produced 10/10 official wins,
  maximum safe dwell 40.4s, maximum active time 265.8s, all seven Floor 1 quests
  completed, and zero quest failures.

## Key Decisions Made

- Safe-room exit geometry is route metadata, never a behavior-tree owner,
  priority, lease, or sticky latch.
- Semantic targets remain authoritative; routed waypoints are separate local
  movement targets and never overwrite `AIDecision.target*`.
- Blocked routes preserve semantic decisions but authoritatively clamp movement
  after every downstream movement layer while allowing watchdog recovery.
- The cloud comparator pins baseline SHA, ordered source workflow IDs, and a
  digest of the exact loss/flag cell sets. Matching counts alone are rejected.
- The canonical gate requires at least 556/600 official wins, at most 11
  > 60-second safe-room flags, zero new flags among baseline official wins,
  > bow:97 and pistol:76 official wins, strict active time under 360 seconds, and
  > legal completion of all seven canonical Floor 1 quests.

## What's Next / Blockers

Push the reviewed cloud-follow-up correction, rerun `ai-sweep.yml` in
`safe-room-route` mode, download the canonical artifact, and record the final
600-run result before opening the dedicated PR. Do not merge the PR.

## Retrospective

### Lessons Learned

Route geometry must be modeled below semantic intent ownership. A geometry
certificate promoted into a long-lived movement owner can monopolize priority,
recreate unreachable certificates, and continually reset stall clocks even
when each individual helper appears locally correct.

### Mistakes Made

The first cloud comparator revision checked only baseline cardinalities. A
reviewer reproduced that a same-size synthetic loss/flag manifest could pass.
Pinning the exact provenance and content digest closed that trust-boundary gap.
The first route-storm correction then made active movement too locally
authoritative: feeding each intermediate door-path tile through a second A\*
controller could wedge on a door center. The existing seed2 headless regression
caught the resulting 359.8-second active streak before push.

### Opportunities for Future Improvement

The generic sweep artifact schema should eventually expose canonical quest and
route lifecycle fields through a shared typed row builder, avoiding parallel
row interfaces between tournament and focused regression gates.
