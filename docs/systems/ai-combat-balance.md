# AI & Combat Balance

Durable findings from balance sweeps against the headless win-rate gate. Each
item names the concrete parameter that traded off, the reproduction data, and
the recommended fix so future tuning does not re-derive the analysis.

## Bow target-leading gap

At ranged standoff the orbit distance is `RANGED_STANDOFF_FRACTION * TILE_PX`
which currently resolves to `352 * 0.75 = 264 px`. Bow projectiles travel at
`48 px/s`, so a fully-drawn shot takes ~`5.5 s` to reach the standoff distance.
Enemies drift at ~`16 px/s`, displacing ~`88 px` over that flight — larger than
any enemy hitbox — so every arrow whiffs when the shooter fires at the enemy's
current position.

Symptoms in the headless sweep: **0 % bow winrate**, `3.5` average kills per
run versus **28.2** for sword.

Fixes (either one closes the gap):

- Lead the target: `lead_time = orbit / projectileSpeedPx;`
  `targetX += enemyVx * lead_time; targetY += enemyVy * lead_time`.
- Halve `RANGED_STANDOFF_FRACTION` to `~0.375`, which cuts flight time to
  ~`2.75 s` and shrinks miss displacement to `~44 px`.

The correct long-term answer is target leading; the standoff halving is a
last-mile ranged-weapon rescue only.

## Baseball-bat knockback loop

The baseball bat applies **40 px** of knockback but has only **44 px** of
melee reach. Every hit pushes the enemy just barely out of range, forcing the
AI to chase for ~`1 s` between the bat's `900 ms` swing cooldowns. Roughly
**53 %** of combat time is spent re-closing distance, and the loop stalls if
the enemy hits a wall or corner.

Fixes:

- Cap AI-applied knockback at `≤ 1 ft` (`≤ TILE_PX / 4`) so the swing cadence
  actually connects on the next tick.
- Or add a post-knockback "wait until in range" branch to the melee AI so it
  does not spend cooldown budget on chase distance the swing itself created.

## Headless seed panel

The old panel `{2, 4, 7}` is unusable as a balance gate. Seeds `4` and `7`
are **unbeatable by any weapon within 330 s** in the headless runner, and the
single seed `2` gives zero coverage for ranged weapons (bows/wands need
different rooms to reach their standoff distance).

**Replace with `{1, 2, 5}`** — every seed is sword-winnable in **≤ 221 s** and
the mix exercises both open-room and corridor rooms so ranged weapons get a
fair test. Do not gate on a single seed; single-seed gates hide entire weapon
classes.

---

<!-- Source handoff: 2026-06-23-weapon-sweep-antagonistic-review.md -->
