# ADR: Passive ability observability seam

## Status

Accepted

## Date

2026-07-31

## Estimated Complexity

🍎🍎🍎 — shared passive presentation metadata, gameplay feedback, engine projection,
and real-scene probe coverage changed together.

## Context

Level-5 passive abilities were already applied by simulation, but two player-visible
surfaces drifted from that runtime truth:

- the Abilities UI projected only active/loadout abilities, so unlocked passives
  were invisible even when they were part of the player's current build;
- passive activation feedback depended on weapon-prerequisite handling, so general
  no-prerequisite passives could apply with no visible confirmation;
- the existing test surface did not assert the rendered MainGameScene projection a
  player actually sees, so gameplay-side passive behavior could stay correct while
  the UI silently regressed.

This branch crosses shared, game, engine, and e2e seams for one reason: passive
ability ownership, application, presentation, and observation must stay aligned as
one player-visible contract.

## Decision

1. **Passives are projected in the shipped Abilities surface.** The MainGameScene
   abilities loadout must render passive abilities alongside the existing active
   entries instead of treating passives as simulation-only state.
2. **Passive rows are read-only status rows.** Passive entries remain visible in the
   same surface but are explicitly non-toggle (`canToggle: false`) and declare their
   runtime state as `ACTIVE` or `INACTIVE`, including unmet prerequisite text when a
   passive is weapon-gated.
3. **Passive presentation metadata lives in `src/shared/`.** Human-readable passive
   effect summaries and prerequisite summaries are authored in shared presentation
   data so the engine can render them without importing game-layer logic.
4. **Gameplay owns first-application feedback.** The ability system emits passive
   activation VFX when a player-held passive becomes applied, including general
   no-prerequisite passives, so the runtime grants a visible acknowledgement at the
   same moment simulation authority changes.
5. **Regression coverage observes the real rendered seam.** The main-scene probe and
   e2e helpers expose rendered loadout entries from the real MainGameScene runtime so
   tests assert the observable projection rather than only internal ability-state
   data.

## Consequences

### Positive

- Players can see unlocked passive abilities and whether they are currently active.
- General passives now provide immediate visible feedback on first application,
  matching weapon-gated passives more closely.
- The real-scene e2e seam now guards against regressions where gameplay passive state
  stays correct but the runtime UI stops reflecting it.

### Negative

- The abilities loadout surface now mixes actionable active rows with read-only
  passive rows, so copy and navigation behavior must continue distinguishing the two.
- Shared ability-presentation metadata must stay synchronized with passive gameplay
  definitions to keep status text honest.

### Risks

- If future passive activation rules change without updating shared summaries, the UI
  can become misleading even while simulation remains correct.
- Probe/e2e seams that mutate skill usage or safe-context state can produce false
  negatives unless they restore the same runtime preconditions the player surface
  requires.

## Alternatives Considered

1. **Keep passives simulation-only and rely on VFX alone.** Rejected because players
   still could not audit which passive bonuses their build currently owns.
2. **Add a separate passive-only modal/panel.** Rejected because it would duplicate
   ability-surface navigation and split one build concept across multiple UIs.
3. **Compute passive descriptions inside the engine from gameplay definitions.**
   Rejected because it would violate the shared→engine dependency direction and make
   engine rendering depend on game-layer logic.
