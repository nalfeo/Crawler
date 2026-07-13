# Floor 1 retreat and kiting investigation plan

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance

## Status

Planning and bounded investigation only. **No retreat implementation has begun.**
No source, test, tuning, weapon, or gameplay files were changed in this session.

The implementation dependency is **unmerged and redesigning**. The safe-room
foundation's Alternative A failed its immutable 600-run gate at **511/600 wins**
with **58 safe-room flags**; its required gate was **at least 556 wins and at
most 11 flags**. No foundation PR was opened. Do not consume that branch or
implement Retreat until a replacement foundation PR passes, merges to `main`,
and the Floor 1 AI coordinator explicitly authorizes this slice.

The planning complexity estimate is **5 apples**. The implementation will still
require the full 5-apple review harness after the dependency lands.

## Scope boundary

This is Floor 1 AI failure slice 2: retreat ownership, threat clearance, escape
target commitment, and the retreat side of movement-owner handoff.

Explicitly outside this slice:

- safe-room parking, exit geometry, and egress ownership;
- final-stair travel;
- route-efficiency/objective scheduling;
- ranged-orbit, melee-kite, dodge-vector, or travel-steering rewrites;
- weapon, spawn, enemy-damage, or persona tuning.

Safe-room/egress owns the first divergence for seeds 18, 54, 2, and 10. Seed 94
is a no-retreat/final-stair transit comparator, not general-kiting evidence.
Retreat owns the premature release first divergence in seeds 78 and 82.

## Durable evidence

The original JSONL, console, and summary artifacts lived in session-state
directories and will not transfer to a fresh machine. The evidence required to
resume is summarized here.

The latest 600-run sweep was at `a8e26a51`. Representative attrition cases
(fireball seed 54, sword seed 78, throwing-knife seeds 2/10/18/82) averaged:

- **7.5 DPS**;
- **48.7% activation accuracy**;
- **1.26 damage taken/s**;
- **84% travel efficiency**;
- **18.1% wiggle**.

Exact bounded traces:

- **seed 78 / sword:** RETREAT starts at **31.3 s**, HP **17**. At HP **12** it
  cycles `RETREAT -> COLLECT -> RETREAT -> COLLECT -> ENGAGE -> RETREAT ->
ENGAGE -> RETREAT`, then dies at about **43.5 s**. Activation accuracy is
  **70.8%**; damage taken is **2.71/s**. This is a retreat-release/ownership
  failure despite acceptable aim.
- **seed 82 / throwing-knife:** RETREAT starts at **83.5 s**, HP **15**, releases
  to ranged ENGAGE at **85.8 s** while still HP 15, re-enters at **86.3 s**, and
  dies at about **88.0 s**. Activation accuracy is **62.5%**.
- **seed 18 / throwing-knife:** **15.8 DPS**, **41.2% activation accuracy**, and
  **41.2% wiggle**. LeaveSafeRoom owns the high-wiggle egress oscillation before
  Retreat begins at about **135 s**.
- **seed 54 / fireball:** only **37 activations** over about **220 s**, **1.4
  DPS**, and **37.8% activation accuracy**. Egress is the first divergence,
  followed by a prolonged low-health loop with **179 RETREAT/LeaveSafeRoom
  transitions**.
- **seeds 2 and 10 / throwing-knife:** repeat the low-HP
  RETREAT/LeaveSafeRoom ownership alternation; they remain egress-boundary
  evidence rather than Retreat-first gates.
- **seed 94 / throwing-knife:** healthy no-retreat/final-stair comparator with
  **17.5 DPS**, **75.2% activation accuracy**, and about **1% wiggle**. It proves
  throwing-knife can produce strong damage/accuracy and should remain a negative
  retreat-activation/progression control.

Seven of the maximum ten bounded local diagnostic runs were consumed:
seed 18/78/54/94 plus seed 2/10/82. Do not recreate these baselines merely
because their files are unavailable. At most three local diagnostic runs remain,
and each requires a documented structural field or diagnosis that deterministic
tests cannot provide. Broad sweeps must run through GitHub Actions.

## Root cause and first divergence

Current Retreat enters below 15% HP when a nearest reachable threat is within
20 ft. It remains active only while a single query finds a threat within the
30 ft hysteresis radius. A one-poll miss, threat identity change, or larger gap
calls `endRetreat()`, which blacklists the prior threat for at least 60 frames.
Track A can then resume COLLECT, ENGAGE, EXPLORE, or egress while the player is
still at 5-13% HP. Separately, the escape target is replaced every 18 frames
without proving arrival, invalidity, or failed progress.

The coherent fix is not a weapon buff or a bundle of geometry rewrites. It is a
durable threat-clearance navigation commitment with explicit movement ownership,
stable target identity, best-so-far progress, and deterministic release/handoff.

## Approved architecture

Retreat must become consumer 2 of the navigation foundation after SafeRoomEgress
proves consumer 1. Do not create a second reducer or parallel state owner.

The last approved expected API was:

- `src/game/ai/navigation-commitment.ts`: pure reducer.
- `src/game/ai/movement-intent-arbiter.ts`: sole movement-owner authority for
  migrated Track-A intents.
- `MovementIntentArbiterState = { current: MovementIntentLease | null;
navigation: NavigationCommitmentState | null }`.
- Persistent generic state lives only at
  `MovementIntentArbiterState.navigation`:
  `{ target, acquiredFrame, bestDistanceFt, ownerNoProgressFrames,
clearWindowFrames, lastProgressFrame, lastReason }`.
- Callers supply immutable per-frame facts:
  `{ latched, ownsMovement, targetValid, distanceFt, arrived, clearCondition,
frame }`.
- Callers supply immutable policy:
  `{ arrivalDistanceFt, progressEpsilonFt, maxOwnerNoProgressFrames,
clearWindowFrames, arrival: 'release' | 'reseed' }`.
- Motion progress/no-progress advances only while that lease owns movement.
  Clear-window state advances while latched regardless of current owner.
- Invalid, arrived, stalled, cleared, and reseed results feed explicit lease
  lifecycle/handoff.
- Retreat uses stable proposal key `retreat:<threatEid>`, supplies target
  geometry/validity/policy/facts, consumes immutable next state, and keeps no
  provider-private best-distance or progress counters.
- Target replacement is an explicit new/reseeded commitment, never hidden
  mutation.

These names are **expected, not available on `main`**. ADR 0060 was the planned
authority, but the failed foundation branch is not merge-ready. On resume, read
the replacement merged ADR and exported types rather than recreating this API.
If semantics differ, return to human plan review before coding.

Navigation route constraints are a hard dependency: target validity must use
stable entity or tile-quantized position identity plus finite, passable, and
reachable route facts. Escape candidates remain Retreat-owned swarm-centroid arc
candidates with bounded A\* reachability checks. Do not treat raw coordinate
movement as target identity, and do not bypass route validity to make seeds pass.

Retreat policy after the foundation lands:

1. Preserve entry at 15% HP, 20 ft entry radius, 30 ft exit radius, existing
   centroid arc candidate generation, and bounded A\* selection.
2. Retreat acquisition is outside-safe only. Retained egress wins at every HP
   and releases through its own lifecycle. Retreat may acquire immediately after
   that structured release; it never reads a private egress predicate.
3. Threat-clear frames advance whenever Retreat is latched; any reachable threat
   inside 30 ft resets them.
4. Best-distance/no-progress advances only while Retreat owns movement.
5. Keep a valid progressing target until arrival, invalidity, or bounded stall;
   remove unconditional 18-frame replacement.
6. Invalid/stalled targets reseed; they do not release an uncleared Retreat.
7. Release requires a satisfied escape goal plus 30 consecutive latched clear
   frames.
8. Remove Retreat-exit enemy blacklisting. Retreat threat sensing must not apply
   engagement-watchdog ignores.

## Planned implementation surface

After a passing foundation PR merges:

- consume `src/game/ai/navigation-commitment.ts`;
- consume `src/game/ai/movement-intent-arbiter.ts`;
- add a pure `src/game/ai/retreat-navigation-policy.ts` adapter if still useful;
- migrate Retreat production/execution in `src/game/ai/bt-ai-provider.ts`;
- replace obsolete repick tuning in `src/game/ai/bt-ai-tuning.ts`;
- extend structured AI event telemetry only if the merged foundation lacks the
  required owner/commitment reasons;
- add pure commitment/policy tests, provider integration tests, and a real
  headless multi-weapon retreat regression.

No new ECS `*System` is expected, so no lab or runtime-system wiring addition is
expected.

## Hard gates

Structural real-headless gates use exact ordered state, movement-owner,
commitment-reason, HP, and kill events rather than sampled snapshots:

- **seed 78 / sword:** no RETREAT exit before goal satisfaction plus the
  30-clear-frame condition; survive to at least **64 s**.
- **seed 82 / throwing-knife:** same ownership/release invariant; survive to at
  least **108 s**.
- Both must have at least one valid Retreat release, remain out of Retreat for at
  least **3 s**, and gain at least one kill after the first Retreat. Endless
  retreat cannot pass.
- **seed 94 / throwing-knife:** remains a no-retreat control and reaches the same
  pre-stair quest milestones.

Slice pre-merge gate, without weapon/stat/spawn changes:

1. zero premature releases in seeds 78 and 82;
2. both survival, valid-release, stable-post-release, and post-retreat-kill
   assertions pass;
3. seed 94 remains a no-retreat control;
4. paired identical **600-run GitHub sweeps** for merge base and implementation
   show no decrease in official Floor 1 wins; report every win-to-loss flip.

Combined acceptance after safe-room, Retreat, final-stair, and route-efficiency
slices all land:

- seed 78 / sword and seed 82 / throwing-knife become official Floor 1 wins;
- paired 600-run sweep reaches at least **90% official wins** with no regression
  against the same-seed pre-program baseline.

DPS, activation count/accuracy, damage taken/s, wiggle, travel efficiency,
retreat duration/repicks, and owner handoffs are diagnostics and tiebreakers, not
brittle balance thresholds.

## Review state

The revised plan received a 5-apple adversarial review from
`claude-opus-4.8`, considered four alternatives, and recorded
`plan_divergence: major_fork`. It established the two-clock invariant, rejected
a retreat-local egress predicate and provider-private commitment state, separated
slice versus combined gates, and required the foundation to prove consumer 1.

That review does not replace the future implementation review harness. After
coding, run the bounded code-review loop, distinct-model multi-model review with
adjudication, committed review ledger, `verify:fast`, `verify:pr-prereqs`, apple
record, handoff update, and scope-gated real-headless validation.

## Fresh-clone resume instructions

1. Clone `nalfeo/Crawler` and check out `nalfeo-plan-retreat-kiting` to recover
   this durable plan.
2. Inspect `main` for a replacement passing safe-room/navigation foundation PR.
   Confirm both the PR merge and explicit Floor 1 AI coordinator authorization.
   If either is absent, stop.
3. Read the merged movement-intent/navigation types and their ADR. Treat the API
   above as historical expected shape, not source of truth.
4. Branch new implementation work from the then-current `main`; do not implement
   on top of the failed Alternative A branch.
5. Re-run preflight, select Producer/Systems-AI ownership, read current AI
   handoffs/instructions, declare 5 apples, and revalidate the plan against the
   merged contract before editing.
6. Reuse the inline baseline above. Preserve the three-run local budget unless a
   specific missing field is documented.
7. Implement only the retreat consumer, run focused deterministic tests, then
   the required 5-apple review and paired pre-merge 600-run GitHub gate.
