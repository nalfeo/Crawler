# ADR 0061: Ranged-persona constitution floor, invincibility frame increase, and rat-brute contact damage reduction

## Status

Accepted

## Date

2026-07-16

## Estimated Complexity

🍎 x 3 — touches src/core (damage), src/game (personas + spawners); three independent constant/value tuning changes

## Context

The canonical weapon sweep (run 29477221792, 2026-07-16, `weapon_personas=true`, 100 seeds × 6 weapons) showed ranged weapons consistently underperforming the 90% win-rate target:

- Bow: 72% win rate, AvgMinHP 46%
- Pistol: 72% win rate, AvgMinHP 47%
- Throwing-knife: 76% win rate, AvgMinHP 45%

Compared to melee weapons (sword 100%, baseball-bat 92%) the gap was large and directly traceable to AvgMinHP — ranged weapons were dying from HP starvation rather than combat-skill deficits.

Analysis identified three independent mechanisms:

1. **Ranged persona constitution minimums were too low** — bow/pistol at 5, throwing-knife at 6 vs. sword at 6, baseball-bat at 7. The AI allocator fills minimumTargets first, so low constitution floors meant ranged builds delayed HP investment and died before reaching their combat damage output.

2. **Player invincibility window was too short for dense early packs** — 250ms allowed damage stacking from multiple simultaneous contacts (rats + brutes in a RATS_NEST defensive wave), which was the primary kill pattern at lv3-4.

3. **Rat Brute contact damage was too spiky** — Rat Brutes (15% of passive spawns, 40% of defensive spawns) dealt 10 damage per contact (2.5× regular rat), contributing to burst-damage kills at early game before constitution was built up.

## Decision

Three cross-layer changes:

1. **`src/game/ai/weapon-personas.ts`**: Raise `minimumTargets.constitution` for ranged personas:
   - Bow: 5 → 7
   - Pistol: 5 → 7
   - Throwing-knife: 6 → 7

   This raises the early-game HP floor for ranged builds (+20 HP for bow/pistol, +10 HP for throwing-knife). Side effect: also raises the gear-score bias toward constitution items in `auto-progression.ts` — this combined effect is intentional (persona should prefer constitution gear too).

2. **`src/core/systems/damageSystem.ts`**: Increase `PLAYER_INVINCIBILITY_MS` from 250 → 350ms. Note: `tuning.json`'s `player.invincibilityMs` field is **not** read by the combat system (it's unused); the authoritative value is the hardcoded constant.

3. **`src/game/spawners/registry.ts`**: Reduce `RAT_BRUTE.contactDamage` from 10 → 7. Note: `damageSystem.ts`'s `DEFAULT_CONTACT_DAMAGE = 5` fallback is **not** relevant (it only applies to entities without an explicit `Damage` component — no real Floor 1 mob uses it).

### Alternatives considered

- **Raise constitution to 8** — the original plan; rejected because with 3 stat points/level the player would delay dexterity/moveSpeed investment through level 3, hurting kiting effectiveness at the lv3-4 death window. A +2 step (to 7) gives meaningful HP without over-delaying mobility.
- **Change tuning.json `player.invincibilityMs`** — not viable: `damageSystem.ts` uses a hardcoded constant that does not read from `tuning.json`.
- **Change `DEFAULT_CONTACT_DAMAGE`** — not viable: this fallback is unreachable for real Floor 1 mobs (RATS_NEST and SLIME_POOL mobs all have explicit `contactDamage` set via the spawner archetype/registry).
- **Isolate changes and sweep independently** — ideal per the issue contract; however the sandbox environment cannot dispatch GitHub Actions `workflow_dispatch` directly, so all three changes were implemented and swept together in the indicative pre-check. A full isolated 100-seed canonical sweep is pending.

## Consequences

### Positive

- Ranged weapon win rates dramatically improved in the 10-seed indicative sweep: bow +28pp (72%→100%), pistol +18pp (72%→90%), throwing-knife +4pp (76%→80%).
- Melee weapons also benefited from the invincibility and brute damage changes: baseball-bat +8pp (92%→100%), sword unchanged at 100%.
- AvgMinHP improved for all weapons, confirming reduced HP starvation and damage stacking.
- Changes are mechanical (constants/values), not algorithmic — zero risk of ECS system corruption or determinism issues.

### Negative

- Throwing-knife at 80% (10-seed indicative) is still below the 90% target; may need a follow-up improvement in a future session.
- The invincibility increase makes the game slightly easier globally (not just for ranged), which may reduce challenge for experienced players.
- Rat Brutes are now less dangerous in defensive waves; if the RATS_NEST encounter feels too easy, brute HP or speed may need a compensating increase.

### Risks

- 10-seed indicative sweep has high variance per weapon (each estimate has ±~15pp confidence). Full 100-seed canonical sweep is required before the changes are considered definitively validated.
- The combined sweep cannot perfectly attribute improvements to individual ideas. If the canonical sweep shows a regression, isolating the culprit requires separate per-idea sweeps.
