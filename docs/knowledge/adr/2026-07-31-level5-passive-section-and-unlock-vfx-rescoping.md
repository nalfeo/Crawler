# ADR: Level-5 passive unlock — distinct section, milestone announcement, VFX rescoping

## Status

Accepted

## Date

2026-07-31

## Estimated Complexity

🍎🍎🍎 — game-layer VFX/announcement emission, shared announcement-event typing,
and engine-layer HUD/UI projection changed together across the same player-visible
contract established by the prior passive-ability-observability ADR.

## Context

PR #2440 (closing issue #2439) added passive ability rows to the Abilities UI and
first-application VFX feedback (see
`docs/knowledge/adr/2026-07-31-passive-ability-observability-seam.md`). Two explicit
user requirements from #2439 were left unimplemented after that merge, and one change
in that PR needed correction:

1. Passive rows rendered appended directly after active rows with no distinct
   "PASSIVE" section separating them — a player scanning the list has no visual cue
   that the entries below a certain point are non-actionable status rows rather than
   more loadout slots.
2. No `HudAnnouncementBanner` unlock announcement fired at the level-5 skill
   milestone, so a first-time passive unlock (the moment simulation authority grants
   it) produced no player-facing "you got something new" feedback distinct from
   ongoing VFX.
3. **Regression to correct:** PR #2440 broadened `applyPassive()`'s VFX condition to
   fire for ALL player passives (removed the prior `weaponPrerequisite !== undefined`
   guard). This meant activation VFX fired on every re-sync/carryover application of
   ANY passive — e.g. reloading a save, re-entering a floor, or any code path that
   re-applies already-owned passives — which misleadingly repeated "you just unlocked
   this" feedback for something the player already had.

This branch again crosses game (`abilitySystem.ts`, `skillSystem.ts`), shared
(`announcement-events.ts`), and engine (`HudAnnouncementBanner.ts`, `HudUI.ts`,
`AbilityLoadoutUI.ts`) seams for the same reason as the prior ADR: passive-unlock
presentation is one player-visible contract, and correcting or extending it requires
touching every layer that contract passes through.

## Decision

1. **VFX is source-scoped by unlock mechanism, not broadened to every apply.**
   `applyPassive()`'s VFX push is restored to only fire for weapon-gated passives
   (`weaponPrerequisite !== undefined`) — this is a repeatable "your weapon choice
   just activated this" cue, intentionally re-fireable each time the matching weapon
   becomes equipped. General (no-prerequisite) passives get their VFX exclusively
   from the level-5 milestone grant site in `skillSystem.ts`, which is already
   one-time-guarded via `triggeredMilestones` — so a general passive's VFX fires
   exactly once, at the moment it is actually unlocked, never on re-sync/carryover.
2. **A new `skillPassiveUnlocked` announcement is unconditional on unlock, not on
   weapon state.** The level-5 milestone site pushes this HUD announcement for
   _every_ granted passive (weapon-gated or general) — decoupled from whether the
   passive is immediately visually active, so "you unlocked X" is always communicated
   even if the passive's own activation VFX won't fire until a weapon requirement is
   later met.
3. **The Abilities UI renders a distinct non-equippable section header.** The
   render-loop overlay in `AbilityLoadoutUI.ts` inserts a "PASSIVE ABILITIES" label
   above passive rows (only when passives exist), reusing the shared presentation
   data already introduced by #2440 rather than creating a second catalog authority.
4. **`HudAnnouncementBanner` gets a real rendered-projection getter.**
   `getCurrentAnnouncement()` returns what the player currently sees (`{kind, text}`
   or `null`), so regression tests assert the observable projection instead of
   internal `world.announcements` state.
5. **Regression coverage extends the existing real-pipeline probe rather than adding
   a parallel one.** The same `MainGameScene`/main-scene-probe-lab e2e test extended
   by #2440 is further extended (not duplicated) to assert the section-header label
   and the polled announcement projection.

## Consequences

### Positive

- General-passive unlock feedback (VFX + announcement) now fires exactly once, at
  the true moment of unlock, eliminating the misleading repeated-VFX regression from
  #2440.
- Players get an explicit "Passive Unlocked: X" announcement distinct from ambient
  VFX, for every level-5 grant.
- The Abilities UI visually separates actionable loadout slots from read-only
  passive status rows, addressing the original #2439 ask that #2440 missed.

### Negative

- Passive-unlock feedback logic is now split across two emission sites
  (`applyPassive` for weapon-gated VFX, the skill-milestone grant block for
  general-passive VFX + all announcements) — future changes to unlock feedback must
  touch both sites and keep their scoping invariants in sync.
- `getCurrentAnnouncement()` is an exact rendered projection only for the
  full-text-rendered kinds (`bossAbilityCast`, `skillPassiveUnlocked`); other kinds
  route through ellipsized display-name + verb rendering, so the getter is not a
  uniform API across all announcement kinds.

### Risks

- If a future weapon-gated passive is granted at level 5 while its matching weapon
  is already equipped, both emission sites could in principle fire VFX on the same
  tick; this is explicitly covered by a dedicated regression test (see
  `tests/game/weapon-skill-abilities.test.ts`) asserting exactly one VFX total, but
  any future refactor of either site should re-verify this test still passes.
- The shared announcement queue is FIFO and unbounded per prior design; a burst of
  unrelated announcements could still delay or evict an unlock banner. This is a
  pre-existing property of the queue, not introduced here, and was explicitly
  accepted as an out-of-scope trade-off during plan review.

## Alternatives Considered

1. **Keep VFX broadened to all passives and add a de-dupe flag instead of a source
   guard.** Rejected — it would require new per-passive "already announced" state
   tracked outside `triggeredMilestones`, duplicating an existing one-time-grant
   mechanism instead of reusing it.
2. **Fire the announcement from `applyPassive` alongside VFX instead of from the
   milestone site.** Rejected — `applyPassive` runs on every apply/re-sync, so
   emitting the announcement there would reintroduce the same repeated-feedback bug
   this ADR fixes; the milestone site is the only place that is genuinely one-time.
3. **Render the PASSIVE section as a separate panel/tab instead of an in-list
   header.** Rejected for the same reason the prior ADR rejected a separate
   modal — it would duplicate ability-surface navigation and split one build concept
   across multiple UI surfaces.

## Related

- `docs/knowledge/adr/2026-07-31-passive-ability-observability-seam.md` (prior ADR
  this one extends/corrects)
- `docs/knowledge/handoffs/2026-07-31-level5-passive-section-and-unlock.md`
