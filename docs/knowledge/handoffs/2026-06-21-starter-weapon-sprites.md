# Handoff — Starter weapon refresh + sprite attacks

## Apples

- Estimated: 🍎🍎🍎 (Medium)
- Actual: 🍎🍎🍎🍎 (Large)
- Delta: +1
- Verdict: 📉 Under
- Notes: The starter-weapon swap itself stayed medium, but preserving the headless Floor 1 gate after changing loadout ordering added an extra cross-system debugging pass.

## Persona routing

- **Producer** — coordinated the cross-layer loadout, weapon-data, renderer, asset, and validation work.
- **Game Designer** — retuned the starter trio to sword / bow / baseball bat and updated starter loadout content.
- **Graphics Designer** — added a dedicated starter-weapon pixel spritesheet and sprite mappings.
- **UX Designer** — replaced placeholder attack visuals with sprite-driven sword/bat swings and bow arrows.
- **QA Engineer** — updated regression tests and fixed the headless-gate regression caused by starter-choice ordering.

## What changed

- Replaced the starter trio with **Sword**, **Bow**, and **Baseball Bat** in both manifest-driven Floor 1/2 starter pools and the legacy loadout scenario helper.
- Retuned starter weapon data:
  - sword kept as the balanced baseline,
  - bow now fires slower, hits harder, and pierces one target,
  - baseball bat was added as a new slow, wide-swing melee weapon with strong knockback.
- Added `public/assets/generated/starter-weapons.png` and registered it as a new engine spritesheet containing sword, bow, baseball bat, and arrow sprites.
- Threaded starter-weapon-specific sprite texture IDs through projectile/melee spawning so the engine can distinguish bow arrows from generic bullets and baseball-bat/sword swings from generic melee arcs.
- Replaced the sword/bat attack placeholders with sprite-based swing animation in `PhaserBridge`, while keeping generic fallback rendering for non-starter weapons.
- Preserved the previous RNG stream in `pickStarterChoices()` by keeping the old random draws and then sorting the 3-item starter trio back into manifest order. This keeps UI/headless starter ordering stable without perturbing the rest of Floor 1 generation.

## Validation

- `bash scripts/agent/preflight.sh`
- `npm run verify`
- `npm run verify:fast`
- `bash scripts/agent/lab-gate-check.sh`
- `npx vitest run tests/headless/floor1-completion.test.ts --reporter=dot`
- `npm run verify`

## Result

- Full local verify is green.
- Lab gate is green.
- Headless Floor 1 completion gate is green after the RNG-preserving starter-choice fix.
