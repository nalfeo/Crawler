# Merge combat-lab into weapon-lab

**Date:** 2026-06-28
**Persona:** Producer
**Branch:** nalfeo-merge-combat-into-weapon-lab
**Apple estimate:** 🍎🍎 → actual 🍎🍎 (on-target)

## Systems touched

weapons

## What

Consolidated the two redundant combat-related labs into a single `weapon-lab`:

- **Deleted** `src/labs/combat-lab/` — its functionality was a strict subset of
  `weapons-lab` (a pistol-only auto-attack arena). All systems it exercised are
  already covered by the broader lab.
- **Renamed** `src/labs/weapons-lab/` → `src/labs/weapon-lab/`. Lab id, name,
  category, and description updated:
  - id: `weapons-lab` → `weapon-lab`
  - name: "Weapons Lab" → "Weapon Lab"
  - category: `Items & Equipment` → `Combat`
- **Updated** lab routing in `src/lab-main.ts` (removed `combat-lab`, renamed
  `weapons-lab` → `weapon-lab`, updated category hint key from `weapons` →
  `weapon`).
- **Updated** lab gate & links: `scripts/agent/lab-gate-check.sh` and
  `scripts/agent/pr-lab-links.mjs` now reference `weapon-lab`.
- **Updated** docs: `docs/architecture.md`, `docs/systems/02-combat.md`,
  `docs/systems/03-weapons.md`, `src/labs/damage-lab/SPEC.md`, and the
  `Combat_System` entity in `docs/knowledge/agent-memory.jsonl`.

Historical handoffs / ADRs / metrics files keep their original `combat-lab` /
`weapons-lab` references — archival.

## Why

The user explicitly asked: "Combat and weapon labs need to be updated. Merge
them into a single Weapon lab. They should allow weapon selection and use the
correct sprites (for weapons that have them and are implemented)."

Combat-lab was the older, narrower bench (hard-coded pistol, basic combat
pipeline). Weapons-lab already supports weapon selection via a dropdown and
runs the full combat pipeline including `meleeSwingSystem`, `beamSystem`,
`trapSystem`, `aoeOnImpactSystem`, `areaDamageSystem`, and
`returningProjectileSystem` — making combat-lab redundant.

## Sprites

No sprite code changes were needed. The merged `weapon-lab` uses the real
weapon system, which already routes through the sprite registry for weapons
that have sprite assets:

- **Melee:** `getMeleeSpriteId(weaponId)` in `src/game/weaponSystem.ts` maps
  `sword` → `MeleeSpriteId.SWORD` (→ `weapon.sword`) and `baseball-bat` →
  `MeleeSpriteId.BAT` (→ `weapon.bat`). PhaserBridge renders the sprite at the
  hand anchor and pivots it through the swing arc.
- **Projectile (ranged):** `ENTITY_KENNEY_SPRITE['proj']` → `weapon.arrow` is
  picked up automatically for `pistol`, `bow`, `crossbow`, etc.
- **Returning (thrown):** `ENTITY_KENNEY_SPRITE['returning']` → `weapon.returning`.

Other weapon types (magic, beam, trap) currently render via procedural
textures, matching the live game — no sprite assets exist for them yet.

## Verification

- `npm run verify:fast` — passed (typecheck + lint + changed unit tests).
- `bash scripts/agent/lab-gate-check.sh` — passed; all weapon-type systems now
  recognized as covered by `weapon-lab`.
- Booted `npm run lab`, navigated to `?lab=weapon-lab` headlessly via Playwright
  - Chromium. Captured screenshot confirming: title "Weapon Lab", weapon
    selector defaults to `sword`, arena populated with player + enemies, and
    after 8s of auto-combat HUD reported "Hits: 5 Misses: 1 (83% hit)" with
    gore splatter visible — sprite rendering and combat pipeline both working.
- Floor1 headless wall-clock test had 1–5 transient failures during the full
  `npm run verify` run (wall-clock-based "coarse blowup guard"); ran the test
  in isolation both with and without my diff stashed — passed in both cases,
  confirming the failures were machine-load flake, not a regression. No game
  code is touched by this PR.

## Files changed

| File                                                             | Change                           |
| ---------------------------------------------------------------- | -------------------------------- |
| `src/labs/combat-lab/index.ts`                                   | **Deleted**                      |
| `src/labs/weapons-lab/index.ts` → `src/labs/weapon-lab/index.ts` | **Renamed + retitled**           |
| `src/lab-main.ts`                                                | Routing + category-hint key      |
| `src/labs/damage-lab/SPEC.md`                                    | Reference `weapon-lab`           |
| `scripts/agent/lab-gate-check.sh`                                | SHARED_LAB_MAP → `weapon-lab`    |
| `scripts/agent/pr-lab-links.mjs`                                 | Mappings → `weapon-lab`          |
| `docs/architecture.md`                                           | Diagram updated                  |
| `docs/systems/02-combat.md`                                      | Labs list updated                |
| `docs/systems/03-weapons.md`                                     | Labs list updated                |
| `docs/knowledge/agent-memory.jsonl`                              | Combat_System entity observation |
