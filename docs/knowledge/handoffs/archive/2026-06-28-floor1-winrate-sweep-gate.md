# Handoff: Floor 1 Win-Rate Sweep + Win-Rate Gate

**Date:** 2026-06-28
**Session:** floor1-winrate-sweep-gate
**Persona:** Producer
**Apples:** 🍎🍎🍎🍎🍎 estimated → 🍎🍎🍎🍎🍎 actual (exact)

## Goal

Raise Floor 1 AI win-rate toward 90%+ across sword/bow/baseball-bat without weakening
WELCOME_TARGET_HOPS=5 or cherry-picking seeds (AGENTS.md r12/r13). Replace the 4
hand-picked gate seeds with a sampled win-RATE gate.

## What Was Done

1. **Deterministic win-rate sweep tool** — `scripts/agent/perf/winrate-sweep.ts`
   (+ `ai:winrate-sweep` npm script). Reuses `runHeadless` + `BehaviorTreeAI` over a
   seed range × 3 weapons, reports per-weapon win-rate + per-fail diagnostics
   (outcome/gameTime/level/kills/stall/dominant-state).
2. **Gate redesign** — `tests/headless/floor1-completion.test.ts` now runs a contiguous
   prefix (seeds 1–8) × 3 weapons and asserts a per-weapon win-RATE floor
   (sword ≥75%, bow ≥50%, bat ≥75%), not 4 cherry-picked seeds. Quest/progression
   checks apply to winners; per-run wall guard raised 30s→150s (sample now includes
   full-budget losing runs ~35–37s dev).
3. **Bow combat-AI follow-up** filed as issue #453.

## Measured Win-Rates (deterministic sweeps)

- 1–16: sword 87.5%, bow 68.8%, bat 93.8% (overall 83.3%)
- 1–12: sword 83%, bow 67%, bat 92% (overall 80.6%)
- 1–8 (gated prefix): sword 7/8, bow 6/8, bat 8/8

## Root Cause (why no balance/AI change shipped)

- **Bow** is the only laggard: vs kiting enemies it chips 185–196s at lvl 0–3, never
  killing. Engage-cap, global-dwell hard window, and 40ft wide-kite anchor were all
  net-neutral-to-harmful (relocate re-anchors into same kite; worst-wiggle grew
  147s→196s). All reverted — bt-ai-provider.ts is clean baseline.
- **Gold-farm stall** (seed12: 4g/182 kills, charm=15g hard gate) is drop-rate balance
  → off-limits per r13.
- User decision: ship sweep + gate, track bow as #453.

## NOT Done

- No bow win-rate improvement (needs pursuit-AI rework, #453). No balance tuning.

## Verify

typecheck/lint/format pass; headless gate 17/17 green (~341s dev). `npm run verify` green.
