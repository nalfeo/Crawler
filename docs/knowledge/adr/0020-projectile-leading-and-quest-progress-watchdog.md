# ADR 0020: Projectile target-leading and quest-progress stall watchdog

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 3 — touches 2 game systems (weapons + AI) and the headless gate; no new ECS
system or lab required (existing weapons-lab / ai-runner-lab + the expanded gate

- new pure-function unit tests cover the touched surface).

## Context

The headless Floor 1 completion gate only proved the floor was beatable with the
**sword** on a single seed. Expanding it to a weapon × seed matrix (sword, bow,
baseball-bat) to prove the floor is winnable across fundamentally different combat
styles surfaced two real, deterministic defects:

1. **Bow aiming.** Ranged/magic/thrown projectiles were fired straight at the
   target's _current_ position. Arrows/bolts travel a few px/frame, so against a
   strafing enemy — and especially the mobile Floor 1 boss — the shot trailed the
   target and whiffed. The bow needed roughly twice the kills of the sword on
   shared seeds, and some seeds timed out in the boss fight entirely.

2. **Quest-progress deadlock.** The existing spatial/HP stall watchdogs
   (`globalDwell`, `exploreDwell`, `collectDwell`) re-anchor on positional drift
   and nearby-enemy chip damage. A knockback/kite loop — a bat punts a quest
   enemy just out of reach and the wedged player chases in a tight orbit landing
   chip hits but never the kill, or a swarm pins the player against a fixed
   "farm N gold" goal — keeps those watchdogs alive indefinitely while making
   **zero** quest progress. Observed: ~188s pinned, kills frozen, run lost.

Both effects read as "the character is stuck in a loop where it can't actually
reach the thing it needs," which is the unifying symptom this ADR addresses.

## Decision

### 1. Lead moving targets for forward-fired projectiles

Add a pure `computeLeadDirection(deltaX, deltaY, targetVelX, targetVelY,
projectileSpeed)` to `weaponSystem.ts`. It solves the standard intercept
quadratic `|delta + targetVelocity·t| = projectileSpeed·t` for the smallest
positive interception time `t` and aims at the predicted position
`delta + targetVelocity·t`. It falls back to direct aim when no positive root
exists (target outruns the projectile) or the projectile is effectively
stationary. The targeting helpers (`getNearestEnemyTarget`,
`findBossTargetInRange`) now carry the target's delta + velocity so the fire
paths can lead. Leading is applied only to `RANGED` / `MAGIC` / `THROWN` weapons
(`isLeadingProjectileWeapon`); melee is unaffected. The ranged path also adopts
the same boss-priority focus the melee path already uses, so a slow arrow locks
onto an in-reach boss instead of trailing a respawning add.

This composes cleanly with the line-of-sight targeting gate from ADR 0018: a
target must still be visible or have clear LOS before we compute a lead for it.

### 2. Quest-progress stall watchdog

Add a deterministic backstop in `bt-ai-provider.ts` keyed on a coarse,
near-monotonic **floor-progress fingerprint** rather than on position. The
scoring is a pure, unit-testable free function
`computeFloorProgressScore(quests, gold)`:

```
score = (Σ per quest: 1 + 100·complete + Σ progress counters + 10·done-flags)
        · QUEST_PROGRESS_SCORE_WEIGHT (1000)
      + gold
```

Quest score is weighted far above gold so a shop purchase (an objective latches;
gold dips by the price) still nets forward progress, while gold re-anchors the
"ready to buy / farm N gold" stage that quest counters alone leave static. When
the running-max score does not advance for `QUEST_PROGRESS_STALL_FRAMES` (6000 ≈
100s) the watchdog calls the shared `relocateFromStall` (ignore the local enemy
wave + loot cluster, drop the current target/path so the BT falls through to
reachability-aware Explore) and suppresses fixed progress goals briefly so
Hunt/Explore can take over. An **active boss battle** legitimately freezes the
fingerprint (one binary objective, no add payouts), so the timer is held while
the boss quest is live and an enemy is in range — the watchdog never abandons the
boss mid-whittle.

### 3. Expand the headless gate to a weapon × seed matrix

`floor1-completion.test.ts` now runs `WINNING_SEEDS` × `GATE_WEAPONS`
(sword/bow/baseball-bat) via the runner's `forceWeaponId`, asserting each combo
clears independently on deterministic game-time. Seeds were re-verified against
the current damage path (crit/dodge rolls, retuned slime pounce band).

## Consequences

### Positive

- Bow/ranged shots connect with moving targets and the boss; the bow clears every
  gated seed instead of whiffing/timing out.
- A class of "moving but making no quest progress" deadlocks the positional
  watchdogs miss now self-recovers within ~100s, deterministically.
- The gate proves Floor 1 across three distinct damage models, not just the one
  weapon the AI happened to equip — far stronger regression coverage.

### Negative

- The matrix triples headless gate runtime (9 combos vs 1). Mitigated by a frame
  cap just past the 5-minute budget and a generous wall-time guard; assertions
  remain on deterministic game-time, so it cannot flake on CPU speed.

### Risks

- Lead aiming assumes roughly constant target velocity over the projectile's
  flight; sharp enemy direction changes still cause occasional misses (acceptable
  — it degrades to the old direct-aim behavior, never worse).
- A mistuned `QUEST_PROGRESS_STALL_FRAMES` could relocate during a legitimately
  slow stretch. The window is set well above the slowest legitimate single-span
  (cross-map travel ~60s; boss whittle additionally guarded), and every gated
  combo passes with the watchdog active, confirming no false-fire on healthy runs.

## Alternatives Considered

- **Faster projectiles instead of leading.** Raising arrow speed would mask the
  aiming bug but changes weapon feel/balance and still trails fast targets.
  Leading is balance-neutral and deterministic.
- **Relax the boss hitbox / slow the boss.** A combat-tuning change with broad
  balance ripple; leading + boss-priority fixes the actual targeting defect.
- **Extend the spatial watchdog instead of adding a quest-progress one.** The
  deadlock is specifically _spatially active_ (the player orbits), so any
  position/HP signal re-anchors it. Progress must be measured on objective state,
  which is what this watchdog does.
