# ADR 0104: Floor 3 companion leash recall + AI-runner decision/path telemetry parity

## Status

Accepted

## Date

2026-09-04

## Estimated Complexity

🍎 x 4 — touches `src/core`-adjacent ECS system logic (`src/game/systems/companionAISystem.ts`),
engine scene wiring (`src/engine/scenes/MainGameScene.ts`), and a lab/debug surface
(`src/labs/ai-runner-lab/index.ts`), with regression coverage spanning unit, headless,
and real-scene e2e boundaries. Declared late in the session rather than at kickoff —
see the companion handoff for the honest timing note.

## Context

Three separate but related Floor 3 companion-experience bugs were reported:

- **#4205** — the AI Runner lab shows the player's live decision/path for debugging,
  but has no equivalent visibility into what the companion(s) are doing, so a
  companion behaving badly is invisible to the same tooling that would catch it
  for the player.
- **#4206** — companions can wander arbitrarily far from the player and never
  return, because the existing target-lock-continuation logic only checks
  self-anchored engagement range (distance from the companion's own position),
  not the player's position, so a companion can chain from fight to fight
  indefinitely while drifting away with no recall mechanism.
- **#4209** — the `⚡ Command` HUD button that unlocks once a Floor 3 companion is
  ready has no explanation of what pressing it does, unlike the analogous
  Abilities-unlock flow which does explain itself.

(#4204 — Floor 3 sometimes skipped the starter-companion choice — was already
fixed by merged PR #4183 and is out of scope for this ADR/PR; it is closed
separately with its own evidence.)

## Decision

### #4206 — sustained-drift stale-lock recall (edge-triggered)

Add `awayStreakByWorld: WeakMap<GameWorld, Map<number, number>>` to
`companionAISystem.ts`, tracking consecutive frames a `TeamId.PLAYER` companion
has spent farther than the existing self-anchored engagement range
(`rivalRangeSq`, derived from `tuning.factionRelations.feudEngagementRadiusTiles`)
from the player. Once that streak exceeds the existing
`tuning.floor3Companion.engagementEndFrames` constant (180 frames / ~3s, already
used elsewhere for KO-recovery grace timing), the **stale-lock continuation
check only** is skipped exactly once — edge-triggered, then the counter resets
to 0. Fresh target acquisition is never gated and stays fully self-anchored, so
combat viability is never reduced.

The recall condition is additionally gated on `world.floorId === 'floor3'`
(added during review, since `companionAISystem.ts` is shared by other floors —
e.g. Floor 4 — and the reported behavior/fix is Floor-3-specific). Without this
gate the change would silently alter companion behavior on every floor that
uses the system, which is an unrelated balance change the non-goals explicitly
forbid. `tests/ecs/companion-ai-system.test.ts` now includes a dedicated
non-Floor-3 test proving a sustained-drift lock never breaks outside Floor 3.

This was the fourth design attempted; the first three all caused real
regressions in the headless pipeline (see Alternatives Considered). No new
tuning constant was invented — both reused constants already exist in
`tuning.json` for closely analogous purposes, per the explicit instruction not
to invent a balance change.

**Known limitation, accepted as a deliberate boundary:** this is a best-effort,
not airtight, recall. If a nearby rival still exists at the exact moment the
streak trips, the companion simply re-locks onto it (a harmless one-frame
stutter) rather than actually returning — so a companion in continuous
back-to-back combat near a persistently-populated distant cluster could
theoretically stay away indefinitely. Every stronger intervention tried
(disabling combat while displaced, gating acquisition) caused real deaths in
the headless pipeline, so this tradeoff was chosen over an unproven "airtight"
guarantee.

### #4205 — companion decision/path telemetry parity

Add `getCompanionTelemetry()` to `src/labs/ai-runner-lab/index.ts`, mirroring
the existing player telemetry shape (`state`/`reason`/`targetX`/`targetY`/`path`)
for each companion, plus `drawCompanionOverlay()` for visual parity with the
player's own path/target overlay, and `getFloor3LossReason()` to distinguish
`party-wiped` / `timeout` / `player-hp` game-over causes for debug/e2e
legibility. This reuses the existing AI Runner debug/trace infrastructure
introduced by merged PR #4183 (`AiRunnerDebugSnapshot`, `floor3SurfaceTrace`)
rather than reimplementing parallel plumbing.

Review found two gaps in the first cut, both fixed before publication:

- The internal `getCompanionTelemetry()` data was only surfaced via canvas
  overlay geometry and a pull-based debug snapshot, not an actual visible UI
  element — so "parity with the player path visualization" wasn't backed by
  anything a human or e2e probe could read directly. Added a visible
  `#ai-companions` cell to the existing Decision-telemetry panel, populated
  from the same `getCompanionTelemetry()` data every render tick, formatted as
  `#<eid> <kind> → (x, y) · N pt path` per companion.
- `getFloor3LossReason()` didn't gate on `world.floorId`, and checked
  party-wipe before player-HP, misclassifying a simultaneous player-death +
  party-wipe frame as `party-wiped` instead of `player-hp`. Fixed to return
  `null` off Floor 3, and to check the player's own HP
  (`world.stores.health.current[playerEid] <= 0`, read directly since the
  Player entity persists post-death) before the party-wipe check.

### #4209 — Command button explainer

Add a `floor3CommandUnlockNotified` latch plus a one-time `flashHint` toast in
`MainGameScene.ts`, shown the first time `floor3PartyAvailable` becomes true,
explaining that `[C]` / the `⚡ Command` button lets the player have their ready
Companion use its signature ability. This mirrors the existing Abilities-unlock
explainer pattern already shipped for consistency with repo UX conventions.

Review found the original condition (`floor3PartyAvailable &&
!floor3CommandUnlockNotified`) checked only `floorId === 'floor3'`, not actual
companion-party availability, and could also fire while a blocking surface
(dialog/menu) was open. Tightened to additionally require
`!this.isBlockingSurfaceOpen()` and
`resolvePartyMemberEids(this.world).length > 0` (the real recruited-roster
check, not just the floor check), so the toast only fires once a companion is
genuinely recruited and nothing is blocking the HUD.

## Consequences

### Positive

- Companions displaced by combat chains now have a deterministic, bounded
  recall opportunity without any change to combat balance or tuning values.
- The AI Runner lab can now diagnose companion misbehavior with the same
  fidelity it already has for the player, closing a debugging blind spot.
- The Command button is now self-explanatory on first unlock, consistent with
  the existing Abilities-unlock UX pattern.

### Negative

- `companionAISystem.ts` gains additional per-companion state
  (`awayStreakByWorld`) that must be cleared alongside existing companion state
  in `resetCompanionAIState()` — an easy place to introduce a future leak if a
  new reset path is added without updating this map too.
- The recall mechanism is reasoned about but not exhaustively proven for every
  possible enemy-density/positioning scenario; it is validated against the real
  Floor 3 headless pipeline, not an exhaustive proof.

### Risks

- **Pathological continuous-combat cluster:** as noted above, a companion could
  theoretically stay away from the player indefinitely if it keeps re-acquiring
  a nearby rival at the exact recall-eligible frame. Mitigation: this is a
  known, accepted boundary; if it manifests in practice, the next iteration
  should consider widening the grace window or adding a secondary
  distance-based hard cap rather than reintroducing acquisition-side gating
  (which is proven to cause deaths).
- **Level- vs. edge-triggered regression:** if a future edit to this system
  reintroduces a per-frame (level-triggered) check instead of the edge-triggered
  one-shot reset, the same combat-thrashing timeout regression from Attempt-4
  iteration 1 will reappear. The unit tests in
  `tests/ecs/companion-ai-system.test.ts` (`sustained-drift stale-lock recall`
  block) and the real headless Floor 3 completion test both guard against this.

## Alternatives Considered

1. **Player-anchored gating on both continuation and acquisition, instant/every
   frame.** Rejected: caused fast companion death — a companion forced into
   passive `'follow'`/`'idle'` while traversing hostile territory to catch up
   has zero combat targeting (`companionCombatSystem.ts` only attacks with a
   valid `rival-primary` decision), so it took unanswered damage.
2. **Self-anchored gate applied to both continuation and acquisition, instant/
   every frame.** Rejected: caused `timeout` via combat thrashing — recomputing
   "nearest target" every single frame spreads damage across many targets and
   never lands a kill, reproducing the exact failure mode the original
   stale-lock-reuse code was written to avoid.
3. **Acquisition-only gate (block fresh acquisition when far from player, leave
   continuation untouched).** Rejected: caused fast death via a different path
   — a poached companion stuck in passive `'follow'` (no target) took sustained
   damage because it was too far from the player for the gate to permit
   re-engagement, only regaining a target once already critically low.
4. **Level-triggered stale-lock-only break (first cut of the accepted design).**
   Rejected: still caused `timeout` — even scoped to continuation only, the
   condition stayed true every frame while sustained-away, reproducing the same
   per-frame-thrashing bug as alternative 2, just for fewer companions.
5. **Edge-triggered stale-lock-only break (accepted).** The only design across
   five iterations that neither disabled combat capability nor caused per-frame
   thrashing; validated against the real headless Floor 3 completion pipeline
   (victory, all 6 studios, all 4 Final Four rounds, companion kept, exit
   confirmed), not just synthetic unit assertions.
