# Handoff — Slime leap + frozen-recovery rebalance

**Date:** 2026-06-22
**Branch / PR:** current working branch
**Persona:** Game Designer
**Apple estimate:** 🍎🍎🍎 (3) · **Actual:** 🍎🍎🍎 (3) · verdict **exact**

## Goal

Implement the slime leap as a real commit-and-recover loop and rebalance it so it
plays the way it was designed: because the player should essentially never stop
moving, a leap committed toward the player's current position generally **misses**,
and the slime is then **frozen** for a recovery window — the deliberate opening the
player attacks into.

## What changed

`src/game/enemyAISystem.ts` — the slime (`AI_TYPE.LEAPER`) cycle gained a third
phase:

```
prep (telegraph wind-up) → leap (committed dash, generally whiffs) → recover (FROZEN)
```

- **New `recover` phase** on `SlimeLeapState`. During recovery the slime's velocity
  is zeroed (`setVelocity(world, eid, 0, 0)`) for `SLIME_RECOVER_MIN_FRAMES`..
  `SLIME_RECOVER_MAX_FRAMES` (20–34 frames, ~0.33–0.57 s at 60 fps). This — not the
  prep crouch — is now the reliable hittable window.
- **`applySlimeLeapBehavior` now returns a boolean.** `true` = it owns the slime's
  movement this frame (mid-cycle); `false` = no active pounce, caller falls back to
  a normal chase. The caller (`enemyAISystem`) was simplified accordingly.
- **Only the `prep` wind-up is gated on the pounce band.** If the player leaves the
  band (closes inside `SLIME_LEAP_INNER_RANGE = 52` or escapes past
  `SLIME_LEAP_RANGE = 96`) while the slime is still _prepping_, the wind-up is
  abandoned and the slime chases. Once committed, the leap (which travels _toward_
  the player) and the frozen recovery (stationary) always run to completion — neither
  is evasive, so this is safe. This preserves the anti-deadlock guarantee that a slime
  is never evasive at melee range while still delivering the freeze.

## The trap I hit (and the fix)

My first pass let the _whole_ cycle run to completion regardless of distance,
including the evasive `prep` wiggle. That re-introduced the exact close-range juke
the earlier "decouple slime leap + inner-range" fix removed: slimes became
unkillable at melee range, piled up under continuous Floor 1 spawns, slowed the sim,
and seed 3 of the headless gate stopped clearing (timeout @ ~333 s, 10 kills vs.
baseline 214 s, 22 kills). Tuning the freeze duration down to 4 frames did **not**
help — proving it was structural, not duration.

Fix: gate only the `prep` phase on the band; let committed leap + freeze finish.
Seed 3 then cleared in **159 s / 24 kills** — actually _faster_ than baseline,
because the freeze genuinely hands the AI (the player) a clean window to land hits.

## Lab

`src/labs/enemy-ai-lab` now spawns and tunes leapers: a **Spawn Leapers (4)** button,
a **Leaper Speed** slider, a leaper count + speed in the HUD readout, and an anchor
below center. Move near a leaper to watch it pounce, whiff, and freeze. Open via
`npm run lab` → `?lab=enemy-ai-lab`.

## Verification

- `npm run verify` — full suite green (typecheck, lint, format, dead-code, **1570**
  unit tests, **8/8** headless gate, build).
- `tests/game/enemy-ai.test.ts` — added `freezes leaper enemies in a recovery window
after each leap` (33 tests total in file). Asserts a fast leap (> 1.5 px/frame)
  precedes a ≥ 15-frame fully-frozen stretch.
- `bash scripts/agent/lab-gate-check.sh` — green.

## Open follow-ups

- Leap commit direction is the player's _current_ position; a future tuning pass
  could add slight lead/lag per slime so a clever player can bait pounces.
- The freeze window (20–34 frames) is tuned against the deterministic headless AI;
  revisit with live playtests once a human is driving.
