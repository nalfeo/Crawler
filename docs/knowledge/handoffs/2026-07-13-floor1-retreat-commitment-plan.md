# Handoff: Floor 1 retreat commitment investigation

## Date

2026-07-13

## Systems touched

ai-behavior-tree, ai-pathfinding, ai-combat-balance

## Status

Investigation and approved design only. No implementation was started. Resume
implementation from then-current `main`, using this branch as research rather than
as an implementation base.

## Root cause

The current low-health Retreat behavior is not committed strongly enough:

1. Retreat enters below the existing 15% HP threshold when a reachable threat is
   close.
2. A one-frame nearest-threat miss or changed nearest threat can end Retreat.
3. Exit blacklists the previous threat.
4. COLLECT or ENGAGE resumes while the player remains at critical HP.
5. The escape target is periodically repicked independent of actual progress.

The first clean outside-safe divergences are:

- Seed 78 + sword: Retreat begins around 31.3s at 17 HP, repeatedly flips among
  Retreat, Collect, and Engage, and dies around 43.5s. Activation accuracy is
  70.8%, but damage taken is 2.71/s.
- Seed 82 + throwing knife: Retreat begins around 83.5s at 15 HP, releases to
  ranged Engage around 85.8s, re-enters, and dies around 88s. Accuracy is 62.5%.

Seed 18 throwing knife, seed 54 fireball, and throwing-knife seeds 2/10 are
safe-room-egress-first failures and are not owned by this slice. Seed 94 throwing
knife is a no-Retreat/final-stair control, not evidence for general kiting.

## Approved architecture

Retreat should become a semantic consumer of the shared navigation commitment
and movement ownership seam after the safe-room navigation-route-constraint
foundation lands.

- No private safe-room predicate or direct safe-room state read.
- No duplicate provider-private best-distance/no-progress counters.
- Retreat submits a stable semantic proposal and data-only commitment policy.
- Threat-clear time advances while Retreat remains latched.
- Motion progress/no-progress advances only while Retreat owns movement.
- A committed target remains stable until arrival, invalidity, or bounded
  best-so-far no-progress.
- Release requires the configured consecutive threat-clear window plus valid
  target completion/invalidation.
- Remove Retreat-exit threat blacklisting; do not change Engage watchdog ignores.

The exact shared API must be taken from the eventual merged navigation foundation,
not from the rejected owner-based experiments on
`origin/nalfeo-safe-room-parking`.

## Hard gates

Structural real-headless gates:

- Seed 78 + sword: no premature Retreat release; survive at least 64 simulated
  seconds.
- Seed 82 + throwing knife: no premature release; survive at least 108 simulated
  seconds.
- Both cases must reach a valid release, remain out of Retreat for at least three
  simulated seconds, and gain a post-Retreat kill.
- Seed 94 + throwing knife remains a healthy no-Retreat control and reaches the
  same pre-stair milestones.

Combined-program acceptance, after all slices land:

- Seed 78 sword and seed 82 throwing knife are official wins under the unchanged
  strict active-time budget.
- No weapon-stat/config changes.
- Canonical GitHub sweep remains at least 90% overall with no cherry-picked seed
  tuning.

## Local diagnostic budget

Seven bounded local captures were already consumed during planning. Do not rerun
automatically. At most three additional local diagnostic runs were reserved for
missing structural fields; document the missing field before spending one.

The prior session-local artifacts will not transfer. Essential metrics and
ownership boundaries are summarized above and in
`2026-07-13-floor1-ai-residual-failures-coordination.md` on branch
`origin/nalfeo-floor1-ai-debug-loop`.

## Resume instructions

1. Wait for the navigation-layer safe-room route-constraint foundation to merge.
2. Start a fresh implementation branch from then-current `main`.
3. Read the merged navigation ownership/commitment ADR and API.
4. Re-run preflight and re-estimate complexity; the approved estimate was 5
   apples with adversarial plan review and multi-model code review.
5. Implement Retreat as a semantic consumer without safe-room-specific branches.
6. Run focused structural tests and the bounded panel, then GitHub-only broad
   validation as required by current policy.

## Non-goals

- Weapon tuning, Retreat entry-threshold tuning, or seed-specific logic.
- Safe-room exit routing or parking behavior.
- Final-boss placement/geometry.
- Mandatory objective route ordering.
- A generic framework duplicated outside the merged navigation foundation.
