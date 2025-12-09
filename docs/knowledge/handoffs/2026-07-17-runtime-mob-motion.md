# Session Handoff: Runtime Mob Motion

## Date

2026-07-17

## Persona

Producer -> Systems Engineer

## Systems touched

enemies, vfx

## Apples

5🍎 estimated, 5🍎 actual (exact)

## What Was Done

Promoted the approved Mob Motion Lab language into the shipped Phaser renderer
for all 85 eligible Floor 1 and Floor 2 mobile archetypes, including bosses and
runtime-only slime/rat variants. Spawners and props remain excluded.

- Extracted dependency-free motion profiles and spawn, locomotion, ranged,
  contact, hit, and active-status samplers into `src/shared/mob-motion.ts`; the
  lab and runtime now consume the same formulas.
- Added authoritative successful-hit delivery metadata so contact motion follows
  delivered contact damage, while projectile hits cannot synthesize melee motion.
- Added monotonic per-entity render generations and complete EID-sidecar cleanup
  so renderer timers cannot leak across bitecs entity reuse.
- Added generation-aware renderer-local state to `PhaserBridge`, including
  first-seen spawn motion, family locomotion, authoritative ranged telegraph and
  fire recoil, contact/hit reactions, active slow presentation, and a
  multiply-safe white flash overlay.
- Preserved facing, identity tint, debug visibility, existing `SpawnAnim`, and
  the complete corpse/blood-pool/skull/desaturation lifecycle.
- Added one table-driven real-`createPhaserBridge` integration gate covering
  100% of the eligible catalog and every applicable state while snapshotting
  gameplay state around each render sync.

Observed in `npm run dev` using the actual Floor 1 game route. Before, the clean
`origin/main` build kept living enemies at their base renderer transforms between
the existing spawn/corpse effects. After, the final branch showed moving
rats/slimes with readable family motion, event-driven attack/hit feedback, and
unchanged corpse and HUD presentation. The only console error in either run was
the existing missing `favicon.ico`. Evidence is stored in session artifacts as
`runtime-mob-motion-before.png`, `runtime-mob-motion-final.png`, and
`runtime-mob-motion-game-contact.png`.

## Key Decisions Made

- Presentation history stays renderer-owned; only authoritative combat facts and
  cosmetic render generations cross the ECS boundary.
- Contact attacks use explicit successful-hit delivery classification rather
  than proximity, cooldown, or damage inference.
- Ranged windup samples telegraph progress; release recoil edge-detects
  `EnemyBehavior.lastFireMs` after establishing a per-generation baseline.
- Corpse state has absolute priority over live motion.
- A separate FILL-tinted duplicate image provides visible white flash without
  destroying identity/status multiply tint.
- Catalog equality in the integration gate makes new eligible Floor 1/2 enemies
  fail closed until they receive a motion profile.

## What's Next / Blockers

No implementation blockers. CI owns the full gameplay and Windows lab-gate
checks. Do not merge the PR without explicit authorization.

## Retrospective

### Lessons Learned

Renderer-local timing still needs a stable lifetime identity because bitecs EIDs
are recyclable. Capturing combat events before `CombatVfx` drains them provides a
clean authoritative seam without moving cosmetic state into simulation.

### Mistakes Made

The first design inferred too much inside the renderer and omitted EID reuse,
delivery classification, and complete catalog proof. Adversarial plan review
caught those gaps before implementation. During code review, multiply-white tint
proved visually inert, duplicated timing literals created a spawn dead zone, and
motion alpha initially replaced rather than composed debug visibility; each now
has deterministic regression coverage.

### Opportunities for Future Improvement

Move runtime-only special archetypes into a single canonical enemy catalog so the
explicit profile additions can disappear. A reusable renderer-side generation
identity helper could also serve future cosmetic state machines.
