# Status-Effect Framework Lab

Exercises the generic, deterministic status-effect / stat-modifier framework
(`src/core/status-effects.ts` + `src/core/systems/statusEffectSystem.ts`).

Run: `npm run lab` → open `?lab=status-effect-lab`.

## What it verifies

- **Two application MODES:**
  - `speed` — **read-site fold-in** (the system does _not_ mutate it; the readout
    calls `computeEffectiveSpeed(base, effects)`, the same path movement uses).
  - `hpRegen` — **per-tick apply** (a heal-over-time the system writes into
    `health.current`, clamped to max, never below current, never on a corpse).
- **Composition** = product-of-factors: `raw = (base + Σ add) * Π multiply`, then
  clamp (`speed` default `[0, base*3]`). Apply _Chill_ (×0.5) + _Haste_ (+40) to
  watch the additive sum and multiplicative product combine.
- **Stack rules:** _Chill_ / _Haste_ use `replace`; _Poison_ uses
  `stack{maxStacks:3}` — apply it 4+ times and watch the oldest stack drop.
- **Timed expiry:** effects tick down by the fixed `GAME.DELTA_MS` step. Use
  _Tick 1 frame_ / _Tick 60 frames_ to advance deterministically; the persistent
  Charm HoT (`durationMs: null`) never expires by ticking.
- **Charm HoT demo:** _Equip Charm_ grants the same persistent `hpRegen` effect
  the Floor 1 Merchant's Charm does. _Damage −25_, then tick, to see HP recover.
  _Unequip Charm_ clears only that instance's effect.

## Determinism

No `Date.now()` / `Math.random()`. Timing is a fixed `GAME.DELTA_MS` per simulated
frame, so a given button sequence always produces identical `remainingMs` / HP.
