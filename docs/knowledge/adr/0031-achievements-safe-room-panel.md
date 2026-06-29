# ADR 0031: Safe-room Achievements panel with reveal-only rewards

## Status

Accepted

## Date

2026-06-28

## Estimated Complexity

🍎 x 4 — touches core, engine, and game plus a new lab, but no new ECS system.

## Context

Achievement unlocks were surfaced via `flashHint`, which shares the bottom
interaction-hint slot and is overwritten every frame by `updateInteractions()`
(Talk/Descend). The "New achievement: <title>" text was clobbered instantly, so
only the lingering Director milestone banner was visible — the unlock read like
flavor, not an award. There was also no in-game way to review earned
achievements or open their rewards; only a devtools editor existed.

We needed (1) a safe-room panel listing unlocked achievements (title, unlock
condition, Director flavor, reward), (2) a correct reveal toast, and (3) a
notion of "claimed". Rewards are reveal-only for now — open the box, show the
tier, mark claimed — because no loot-grant pipeline exists yet.

## Decision

- Add `claimedIds: Set<string>` to `world.achievements` and put claim logic in
  **core** (`src/core/systems/achievementRewards.ts`: `claimAchievementReward`,
  `isAchievementClaimed`). The game `achievementSystem` re-exports them so tests
  keep one import path. This lets `src/engine/` import the claim API directly
  without violating the engine↛game layer rule.
- Add `src/engine/AchievementsUI.ts`, a factory panel mirroring `EquipmentUI`,
  toggled by key `V` / 🏆 Awards button, gated to safe rooms with ≥1 unlock.
- Give the reveal its own `achievementToast` slot/timer; stop routing
  achievement flavor through the Director banner (banner keeps fixed commentary).
- Add `achievements-ui-lab`; map `achievementRewards` to it in the lab gate.

## Consequences

### Positive

- Unlocks read as awards; players can review and open rewards in safe rooms.
- Claim state is core-owned and deterministic; engine stays portable.

### Negative

- Rewards are cosmetic until a loot-grant system lands.

### Risks

- `claimedIds` must be serialized with future save/load work.

## Alternatives Considered

- Keep claim logic in game and have engine call game — rejected (layer break).
- Reuse the Director banner for reveals — rejected (shared slot, lingering text).
