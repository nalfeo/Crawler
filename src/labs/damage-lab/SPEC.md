# Damage Lab Spec

## Purpose

Interactive sandbox for verifying the `damageSystem` formulas, interactions, and edge cases in isolation — without needing full combat-lab infrastructure.

## System Under Test

`src/core/systems/damageSystem.ts` — handles:

1. **Projectile → Enemy** damage (with pierce tracking)
2. **Enemy → Player** contact damage (with invincibility frames)
3. **Enemy Projectile → Player** ranged damage (with invincibility frames)
4. **Armor mitigation**: `max(1, rawDamage - armor)`
5. **Pierce**: projectile passes through N enemies, hit-set prevents double-hit
6. **Returning**: after pierce exhausted, projectile returns instead of destroying

## Lab Sections

### Panel 1: Damage Calculator (static)

- Sliders: `incomingDamage` (1–200), `armor` (0–50)
- Live output: `effectiveDamage = max(1, incoming - armor)`
- Shows formula breakdown as text

### Panel 2: Invincibility Frame Tester

- Displays a player entity with health bar
- Button: "Hit Player" applies contact damage
- Shows: last-hit timestamp, cooldown remaining (250ms bar), whether next hit would be blocked
- Slider: `PLAYER_INVINCIBILITY_MS` override (50–1000ms) for tuning

### Panel 3: Pierce Simulation

- Spawns a row of enemy entities (slider: 1–10 enemies)
- Fires a projectile with configurable pierce count (0–10)
- Visual: enemies flash red when hit, projectile continues or destroys
- Log: shows hit order, which enemies were hit, final projectile state

### Panel 4: DPS Calculator

- Inputs: damage per hit, fire rate (hits/sec), pierce, armor
- Output: effective DPS against single target, effective DPS against N grouped enemies
- Graph: DPS vs armor curve (simple canvas line chart)

## Controls (lil-gui)

```javascript
Damage Calculator/
  incomingDamage: 25
  armor: 5

Invincibility/
  invincibilityMs: 250
  contactDamage: 5

Pierce/
  pierceCount: 1
  enemyCount: 5
  projectileDamage: 10

DPS/
  damagePerHit: 10
  fireRate: 3
  pierce: 1
  targetArmor: 0
```

## Canvas Layout

- Split into 4 quadrants, each with a heading and visualization
- Dark background consistent with other labs
- Use simple DOM rendering (no Phaser needed — this is a formula lab)

## Interactions

- All calculations update live as sliders change
- Pierce simulation has a "Fire" button that animates the projectile
- DPS graph redraws on parameter change

## Non-goals

- Does NOT test actual ECS entity creation (that's combat-lab's job)
- Does NOT render Phaser sprites
- Pure math/formula visualization
