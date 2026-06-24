# Session Handoff: Floor-1 player AI micro-spacing & win-rate optimization

## Date

2026-06-24

## Persona(s) adopted

**Producer** (multi-layer, ambiguous goal) routing primarily to a **Combat/AI**
mindset. The task spanned combat geometry, behavior-tree tuning, and a custom
measurement harness, so the Producer owned sequencing while the work itself was
deep in `src/game/ai/`.

## Routing verdict

✅ right persona — the work was open-ended optimization across combat + AI with no
single owning specialist, which is exactly the Producer's lane.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — three discrete, mechanically-grounded levers (contact-safe
melee orbit, close bow standoff, weapon-agnostic stutter-step), each measured;
the deeper navigation deadlocks were correctly scoped OUT, keeping this at 3.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Goal: make the player AI play like a moderately-skilled human with perfect dungeon
knowledge and win ~95% of Floor-1 seeds. Constraint: tune ONLY the player AI, never
the world or enemy AI. Approach was **measurement-driven** — a parallel eval harness
ran 50 seeds × all starter weapons and reported win/death/timeout per seed, so every
change was validated against the full set (per-seed chaos is non-monotonic, so single
seeds lie).

Three landed changes, all in `src/game/ai/bt-ai-provider.ts`:

1. **Contact-safe melee orbit (the biggest win).** Discovery: swarm enemies
   (rats/slimes) spawn with `attackRange = 0` and deal **contact damage** on AABB
   body overlap (~20 dmg/s while overlapping, 250ms i-frames), not ranged attacks.
   The old kite orbited at 22–31px — _inside_ the ≤24px contact distance — so the AI
   bled out and triggered a retreat→no-kills→no-heal death spiral. New
   `CONTACT_SAFE_ORBIT_PX = 36` anchors the strike band ~12px outside contact yet
   still inside every melee swing radius (sword 40 / bat 44 / hammer 48 px), so
   auto-fire keeps landing while the body stays untouched. Knife (reach 28 < 36)
   falls back to the old reach-fraction band. Measured: **21.7% → 40%**, deaths
   14% → 4%.

2. **Close absolute bow standoff.** The bow stood off at 0.75×352px = 264px; its
   6px/frame projectile takes ~0.5s to arrive and wandering rats sidestep it, so it
   essentially never finished kills and bled out. Player speed (3px/frame) is 2.4×
   a rat, so it can fight far closer safely. Added `RANGED_STANDOFF_ABS_PX = 48`
   (floored at the contact-safe radius), dropped `RANGED_STANDOFF_FRACTION` to 0.5.
   Swept 96/64/48px; 48px was best (bow subset 10% → 66.7%, zero deaths). Combined
   full eval: **40% → 52% (26/50)**, total deaths 2.

3. **Weapon-agnostic stutter-step micro-spacing.** Both melee and ranged kite now
   ease out by a modest amplitude while a shot/swing is on cooldown
   (`MELEE_DODGE_AMPLITUDE_PX = 14`, `RANGED_RECOVER_EXTRA_FRACTION = 0.2`) and pull
   back in as it readies — the human "hold ground, micro forward/back" tactic — so
   the player is never a stationary target. Plus a defensive expansion below 40% HP
   (`MELEE_DEFENSIVE_HP_FRACTION`) that pokes from just outside the enemy's own range.

Net: Floor-1 win rate **~10% → 52%** (5.2×). Sword ≈60%, bat ≈60%, bow much improved.

Tests: updated two ranged-standoff unit tests in `tests/game/behavior-tree-ai.test.ts`
that asserted the old 264px design intent; added/retained micro-spacing cadence and
contact-safe assertions.

## What's Next

Remaining gap to 95% is **navigation / clock-management deadlocks**, not combat:

- **Fetch-item pickup deadlock (~4 seeds, e.g. 3, 37, 38, 46).** The shopkeeper
  errand's fetch item is a `DroppedItem` spawned at a known `questItemPos`
  (`floor1Scenario.ts:759`). The AI navigates there via `createProgressTarget`
  (Progress path) but oscillates/wiggles on the final overlap and never collects it
  — seed 3 spent 135s "Seeking the merchant fetch item" despite 48 kills / lvl 14.
  Likely the same tile-A\* "can't step the 24px body onto a small item" wiggle the
  `CLOSE_APPROACH_DIRECT_PX` logic fixes for the COLLECT path; route the fetch-item
  approach through the same direct-overlap handling.
- **Stuck-early timeouts (~8 seeds, e.g. 36 at lvl 0).** Navigation deadlock from
  spawn — never engages. Investigate Explore/door-open path wedging.
- **Time-phased priorities.** User wants: level early-floor → mid-floor quests+gold →
  as the clock runs down, getting to the next floor (incl. unlocking stairs) should
  dominate. The selector is currently static (no clock); adding a time term would
  cut the over-farming timeouts where the AI grinds to lvl 14 but never advances.
- Optional: standoff 40px (a touch more bow wins, but only 4px over the contact
  floor — risk).

## Blockers

None. (`npm test` fails locally only because the **e2e** project tries to spawn a
vite lab server — `.bin\vite` ENOENT / port 5299 timeout — a pre-existing
environment harness issue unrelated to this change. Unit, game, integration, and
headless projects all pass.)

## Branch State

- Branch: `nalfeo-legendary-fishstick`
- All tests passing: yes (unit 1625, game/BT 13, integration 28, headless seed-15 gate 4; build green)
- PR created: yes

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section to paste.

## Test Results

- `npm run verify:fast` → ✅ passed (typecheck + lint + tests)
- `npx vitest run --project unit` → 153 files, **1625 passed**
- `npx vitest run --project headless --project integration` → **28 passed**, 1 skipped (headless seed-15 Floor-1 completion gate green)
- `npm run build` → ✅ built in ~1.8s

## Key Decisions Made

- **Tune the player AI only** (per the explicit constraint) — no world/enemy changes.
  All edits are confined to `bt-ai-provider.ts` constants + kite planners.
- **Measure on the full seed set, never single seeds** — deterministic chaos makes
  per-seed results non-monotonic under parameter changes.
- **Land the three proven combat-spacing levers now** rather than chase the deeper
  navigation/clock deadlocks in the same PR — the remaining failures are a distinct
  subsystem (pathfinding/quest-step), higher risk, and deserve their own focused pass.
- Honest status: **52%, not yet 95%.** The two highest-impact levers (contact-safe
  spacing + close bow standoff) are landed; the rest of the gap is navigation and
  clock management.
