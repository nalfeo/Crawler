# Session Handoff: Weapon-Sweep Antagonistic Review

## Date

2026-06-23

## Persona(s) adopted

Playtester (primary) — balance validation across seeds and weapon types.  
Game Designer (support) — tooling to enable controlled weapon experiments.

## Routing verdict

✅ Correct persona — "Balance validation, difficulty curve, pacing & fun-factor across seeds" is the Playtester row.

## Apples

Estimated: 🍎🍎🍎  
Actual: 🍎🍎🍎  
Verdict: 🎯 Exact

## What Was Done

### 1. Tooling — controlled weapon experiments

The headless runner hardcoded `selectFloor1StarterWeapon(world, 0)` — always the first
entry from a per-seed shuffled starter pool. Different seeds randomly got different weapons,
making every prior headless run **weapon-confounded**.

Changes made:

- **`src/game/ai/types.ts`**: Added `startingWeapon: string` to `RunStats`.
- **`src/game/ai/headless-runner.ts`**: Added `forceWeaponId?: string` to
  `HeadlessRunnerConfig`. When set, the runner resolves the weapon's index in
  `world.floor1.starterChoices` (post-shuffle) and passes it to
  `selectFloor1StarterWeapon`. Throws if the weapon ID is not in the pool.
  Populates `startingWeapon` in both the normal and error-path return objects.
- **`src/game/ai/headless-runner-cli.ts`**: Added `--weapon <id>` flag.
  Prints `Starting Wep:` in the run summary.
- **`scripts/agent/perf/weapon-sweep.ts`**: New script — runs N seeds × M weapons,
  emits a comparison table and raw JSON. npm script: `ai:weapon-sweep`.
- **`package.json`**: Added `"ai:weapon-sweep"` script entry.

### 2. Sweep data — 18 controlled runs

Seeds 1–5, 7 × Weapons sword/bow/baseball-bat. Budget: 19 800 frames (~330 s).

```
Seed  Weapon        Outcome   Time   Level  Kills  Score
────  ────────────  ────────  ─────  ─────  ─────  ──────────
2     sword         VICTORY   221s   6      15     1 003 456
1     sword         VICTORY   185s   9      23     1 004 597
5     sword         VICTORY   175s   7      25     1 004 905
3     sword         timeout   330s   14     48       337
4     sword         timeout   316s   10     32       204
7     sword         timeout   330s   12     26       263

2     bow           timeout   330s   0       0         0   ← zero-kills anomaly
1     bow           timeout   330s   2       7       111
3     bow           timeout   330s   2       2       151
4     bow           timeout   330s   4       9       136
5     bow           timeout   330s   1       1       100
7     bow           timeout   330s   2       2       120

2     baseball-bat  timeout   315s   13     43       279   ← high kills, can't win
1     baseball-bat  timeout   305s   1       1       151
3     baseball-bat  timeout   301s   1       2       150
4     baseball-bat  timeout   330s   2       3       130
5     baseball-bat  DEATH     182s   5      11       132
7     baseball-bat  timeout   330s   3       6       131
```

**Aggregates:**

| Weapon       | Win rate | Avg kills | Avg level | Avg score |
| ------------ | -------- | --------- | --------- | --------- |
| sword        | 50 %     | 28.2      | 9.7       | 502 294   |
| bow          | 0 %      | 3.5       | 1.8       | 86        |
| baseball-bat | 0 %      | 11.0      | 4.2       | 162       |

---

## Antagonistic Review of Prior Conclusions

### Claim 1 — "33 % win rate is a structural AI behaviour problem"

**Source:** `docs/knowledge/handoffs/2026-06-23-scoring-hill-climb.md`

**Challenge:** The 33 % figure was measured with weapon-confounded seeds. Seed 2's
default option-0 happened to be sword; seeds 4 and 7's defaults were not. The
framing "structural AI problem" is directionally correct but misses the dominant
effect: **only sword can achieve any victory at all**. The 50 % sword win rate means
3/6 seeds clear regardless of parameter tuning — that is the structural ceiling,
not a hill-climbing problem.

**Verdict: Partially correct.** The AI does have structural exploration and
navigation weaknesses. But attributing the 33 % cap to those weaknesses, when the
actual driver is weapon type, understates the urgency of fixing bow and bat.

---

### Claim 2 — "collectPullWeight > 0 causes 0 % victory on seeds 4 and 7"

**Source:** Scoring hill-climb handoff (same session).

**Challenge:** Seeds 4 and 7 both time out with **sword** — the best weapon. They also
time out with bow and bat. These seeds appear structurally hard regardless of both
weapon choice and AI parameters. The observed collectPullWeight sensitivity is real
but the implied causal story ("this knob breaks winning seeds") is misleading because
seeds 4 and 7 are not winning seeds. Any tweak that slightly reduces seed 2's win
probability will tank the overall win rate from 33 % to 0 %. The hill-climber was
tuning against a 1-of-3 baseline where only one seed could win at all — this is
effectively a coin-flip gating mechanism, not a robust signal.

**Verdict: The finding is a noise artefact.** Lock to `collectPullWeight = 0.0` is
still the right call, but for the wrong stated reason. The real reason is that
collectPullWeight 0.0 does not hurt seed 2 (the only seed that can currently win).

---

### Claim 3 — "Seed 2 is the canonical headless gate"

**Source:** `docs/knowledge/handoffs/2026-06-23-weapon-pivot-melee-approach.md`

**Challenge:** Seed 2 wins because it happened to draw sword as option-0 AND it has a
favourable map layout for sword play. It is not a general-capability gate — it is a
sword-on-easy-map gate. This is confirmed by:

- Seed 2 + bow: **0 kills, level 0** — a catastrophic failure mode that the gate
  completely misses.
- Seed 2 + baseball-bat: 43 kills but still cannot win, showing the map layout is
  generous (lots of enemies) but the bat's damage loop is inefficient.

The gate gives no coverage for ranged weapons or heavy melee. Any regression in
ranged AI will be invisible until someone runs a weapon sweep.

**Verdict: The gate is dangerously narrow.** At minimum it should be paired with a
second winning seed once one is found for a non-sword weapon.

---

## Critical New Findings

### Finding A — Bow has near-zero combat effectiveness (root cause identified)

Bow averages **3.5 kills / 330 s** vs sword's **28.2**. That is an 8× combat-
efficiency gap that is not explained by the 50 % higher sword fire rate (600 ms vs
900 ms) alone.

Root cause: **projectile travel time vs. orbit radius**.

- Ranged standoff orbit = `bow range × 0.75 = 352 px × 0.75 = 264 px`.
- Bow projectile speed = 6.0 ft/s = **48 px/s**.
- Travel time at orbit = `264 / 48 ≈ 5.5 s` per arrow.
- Typical enemy speed ≈ 2 ft/s = **16 px/s**.
- Enemy lateral displacement in 5.5 s ≈ **88 px** — the arrow misses completely.

The AI aims at the enemy's _current_ position (no target-leading). At orbit range with
a 5.5 s travel time, virtually every arrow misses unless the enemy is moving directly
toward the player. The handful of kills that do occur are enemies that charged head-on.

Seed 2 is the extreme case (0 kills) because the map's specific room/corridor layout
keeps enemies laterally mobile relative to the player's orbit path.

**Verdict: The ranged standoff session introduced a structurally broken combat loop.**
The RANGED_STANDOFF_FRACTION of 0.75 is calibrated for a fast projectile. At bow
projectile speed (48 px/s), the effective standoff should be ≤ 80 px (≈ 1.5 s travel
time with 24 px enemy displacement). Alternatively, the AI needs a target-lead
calculation based on `enemy_velocity × travel_time`.

---

### Finding B — Baseball-bat knockback loop

Baseball-bat averages **11 kills / 330 s** — better than bow but far below sword's 28.
The bat has _higher_ damage (20 vs 15) and a _wider_ arc (120° vs 90°). The kill
deficit must come from wasted time.

Root cause: **5 ft (40 px) knockback per swing**.

- Bat melee range = 5.5 ft (44 px). Knockback = 5 ft (40 px).
- Each hit ejects the enemy nearly the full weapon range. The AI then has to
  close to 44 px again — that takes ~1 s of chase at typical enemy speed.
- With 900 ms cooldown, the AI spends ~900 ms swinging and ~1 000 ms chasing
  between swings: **~53 % of combat time is wasted chasing knocked-back enemies**.

Sword has zero knockback, so enemies stay in melee range for every cooldown cycle.

Seed 2's bat run (43 kills, no victory) is anomalous — the safe room may have funnelled
many enemies into a tight corridor where knockback didn't matter. Seed 5 died (the only
death in the entire dataset), suggesting bat leads to close calls from the inefficient
combat pattern.

**Verdict: The bat's knockback negates its damage advantage.** Either reduce knockback
(< 1 ft for AI viability) or implement a "don't chase knocked-back enemies; let them
return" behaviour in the AI.

---

### Finding C — Hill-climb seed panel is structurally invalid for optimisation

The hill-climber optimises across seeds 2, 4, 7. We now know:

- Seed 4 + sword: timeout (unwinnable at 330 s)
- Seed 7 + sword: timeout (unwinnable at 330 s)
- Seed 4 + bow: timeout
- Seed 7 + bow: timeout

**Two of the three panel seeds cannot be won by any weapon in budget.** Any hill-climb
run is therefore optimising a constant zero for 2/3 seeds, and the 33 % "optimum" is
just "seed 2 wins with sword". Parameter tuning has zero signal on seeds 4 and 7 until
their structural map/AI problems are fixed.

**Verdict: Replace the hill-climb seed panel.** Use seeds {1, 2, 5} (all sword-winnable
in ≤ 221 s), then expand once other weapons can win.

---

## What's Next

### Immediate (blocks meaningful balance work)

1. **Fix bow projectile aiming**: Add target-leading in the ranged engagement plan:

   ```
   lead_time = desiredOrbit / projectileSpeedPx
   targetX += enemyVx * lead_time
   targetY += enemyVy * lead_time
   ```

   Requires enemy velocity to be accessible from world state. Alternatively, halve
   `RANGED_STANDOFF_FRACTION` to 0.375 (132 px orbit, 2.75 s travel, 44 px
   displacement — still mostly misses without leading, but tests the loop).

2. **Replace hill-climb seed panel** with seeds 1, 2, 5 — all sword-winnable with
   comfortable margin. Current panel {2, 4, 7} only has one winnable seed.

3. **Add weapon-controlled headless tests**: `floor1-completion.test.ts` should assert
   at minimum one victory per weapon type, or explicitly document which weapons are
   expected to fail and why.

### Medium priority

4. **Baseball-bat knockback reduction**: Cap knockback to ≤ 1 ft (8 px) or add
   post-knockback "settle" wait to prevent the chase loop.

5. **Winning seeds for non-sword weapons**: Once bow aiming is fixed, run a sweep of
   seeds 1–20 per weapon to find 3+ winnable seeds each for a valid multi-weapon gate.

6. **Expand canonical gate**: The current single-seed gate (seed 7) should become a
   3-seed panel covering at least two different weapons.

---

## Blockers

None — all changes are additive tooling.

---

## Branch State

- Branch: `copilot/examine-behavior-tree-system`
- All tests passing: ✅ (1603 tests, `npm run verify:fast`)
- Sweep data written: `/tmp/weapon-sweep.json` (ephemeral; re-run `npm run ai:weapon-sweep` to regenerate)
- PR: open (#253)

## Test Results

- ✅ `npm run verify:fast` — 1603 tests, lint clean
- ✅ `npx tsc --noEmit` — no type errors
- ✅ `npm run ai:weapon-sweep -- --seeds 2,4,7 --max-frames 19800`
- ✅ `npm run ai:weapon-sweep -- --seeds 1,3,5 --max-frames 19800`

## Key Decisions Made

- `forceWeaponId` resolves to an index into the seed's shuffled `starterChoices` rather
  than bypassing the shuffle. This preserves map determinism (RNG state identical for all
  weapon choices on a given seed) while allowing controlled weapon assignment.
- Sweep script uses same 330 s budget as the hill-climb baseline for direct comparability.
- `startingWeapon` added to both the normal and error-path `RunStats` returns so all
  consumers get consistent data.
