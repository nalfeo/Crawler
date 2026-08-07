/**
 * Combat VFX renderer — consumes CombatEvent[] from the world and spawns
 * floating damage numbers / "BLOCKED" indicators in Phaser.
 *
 * Also drains `world.abilityActivations` and spawns the ability-name floater
 * above the player, so an active skill firing announces itself the same way a
 * damage number does.
 */
import type Phaser from 'phaser';
import type { CombatEvent } from '../shared/combat-events.js';
import type { FloaterEvent } from '../shared/floater-events.js';
import type { AbilityActivationEvent } from '../shared/ability-activation-events.js';
import { ftToPx } from '../shared/units.js';
import type { GameWorld } from '../core/world.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';

const VFX_DURATION_MS = 600;
const VFX_RISE_PX = 24;
const FONT_SIZE = '12px';
const SKILL_LEVEL_UP_FONT_SIZE = '13px';
const SKILL_LEVEL_UP_COLOR = '#86efac';
const SKILL_FLOATER_BASE_Y_OFFSET_PX = -22;
const SKILL_FLOATER_STAGGER_Y_PX = 12;
const SKILL_FLOATER_STAGGER_X_PX = 10;
const CRIT_FONT_SIZE = '16px';
const ABILITY_FONT_SIZE = '14px';
const FONT_FAMILY = 'monospace';

/**
 * Ability floaters linger longer and rise further than damage numbers: the
 * label is a word rather than a two-digit number, so it needs more dwell time
 * to be readable mid-fight.
 */
const ABILITY_VFX_DURATION_MS = 1100;
const ABILITY_VFX_RISE_PX = 34;
/**
 * Ability floaters spawn above the damage numbers so the two never collide on
 * the same frame (damage floaters spawn at -8 px from the entity origin).
 */
const ABILITY_VFX_BASE_OFFSET_PX = 22;
/**
 * Vertical spacing applied when several abilities fire on the same frame, so
 * simultaneous activations stack instead of overprinting each other.
 */
const ABILITY_VFX_STACK_OFFSET_PX = 14;

/** Category → colour for ability-activation floaters. */
const ABILITY_CATEGORY_COLORS: Record<AbilityActivationEvent['category'], string> = {
  combat: '#ffb347',
  defense: '#7fd4ff',
  utility: '#b98cff',
};

/** Spells read as arcane regardless of category, matching their cast VFX. */
const SPELL_COLOR = '#c77dff';
export const ABILITY_FLOATER_NAME_PREFIX = 'ability-activation-floater:';

interface FloatingText {
  obj: Phaser.GameObjects.Text;
  startMs: number;
  startY: number;
  durationMs: number;
  risePx: number;
}

/** Resolved presentation for a floating combat indicator. */
export interface FloaterStyle {
  label: string;
  color: string;
  fontSize: string;
}

/**
 * Pure mapping from a combat event to its floating-text presentation.
 *
 * Numeric damage is rounded to a whole number for display: the underlying
 * amounts come from f32-backed ECS stores (health / damage), so an integer
 * value such as 8 round-trips to `8.00000011920929`. Rounding is display-only —
 * the precise amount is preserved in the event and in the health stores.
 */
export function combatFloaterStyle(event: CombatEvent): FloaterStyle {
  if (event.type === 'miss') {
    return { label: 'MISS', color: '#a0a0a0', fontSize: FONT_SIZE };
  }
  if (event.type === 'dodge') {
    return { label: 'DODGE', color: '#44ddff', fontSize: FONT_SIZE };
  }
  if (event.type === 'blocked') {
    return { label: 'BLOCKED', color: '#888888', fontSize: FONT_SIZE };
  }

  const amount = Math.round(event.amount);
  if (event.targetType === 'player') {
    return { label: `-${amount}`, color: '#ff4444', fontSize: FONT_SIZE };
  }
  if (event.isCrit) {
    // Critical hit on an enemy — emphasized: brighter, larger, trailing "!".
    return { label: `-${amount}!`, color: '#ff8800', fontSize: CRIT_FONT_SIZE };
  }
  return { label: `-${amount}`, color: '#ffdd44', fontSize: FONT_SIZE };
}

/**
 * Pure mapping from an ability-activation event to its floating-text
 * presentation. Labels render verbatim (upper-cased for punch) so the player
 * reads the ability's real name.
 */
export function abilityFloaterStyle(event: AbilityActivationEvent): FloaterStyle {
  return {
    label: event.label.toUpperCase(),
    color: event.kind === 'spell' ? SPELL_COLOR : ABILITY_CATEGORY_COLORS[event.category],
    fontSize: ABILITY_FONT_SIZE,
  };
}

/**
 * Pure mapping from a non-combat floater event to its presentation. Skill
 * level-ups read in the class-skill green already used by the HUD skill
 * tracker, so the "+1" is legible as progression rather than damage.
 */
function noticeFloaterStyle(event: FloaterEvent): FloaterStyle {
  return {
    label: event.label,
    color: SKILL_LEVEL_UP_COLOR,
    fontSize: SKILL_LEVEL_UP_FONT_SIZE,
  };
}

function skillFloaterOffsetPx(index: number): { x: number; y: number } {
  const lane = Math.floor(index / 2) + 1;
  const direction = index % 2 === 0 ? -1 : 1;
  return {
    x: index === 0 ? 0 : direction * lane * SKILL_FLOATER_STAGGER_X_PX,
    y: SKILL_FLOATER_BASE_Y_OFFSET_PX - index * SKILL_FLOATER_STAGGER_Y_PX,
  };
}

export function createCombatVfx(scene: Phaser.Scene): {
  update(world: GameWorld, renderElapsedMs: number): void;
  destroy(): void;
} {
  const floaters: FloatingText[] = [];

  function spawnFloater(
    event: { x: number; y: number },
    style: FloaterStyle,
    renderElapsedMs: number,
    offsetPx = { x: 0, y: -8 },
  ): void {
    const { label, color, fontSize } = style;

    // event.x/y are world feet; scale to pixels for rendering. The offset is
    // a pixel offset applied after scaling.
    const floaterX = ftToPx(event.x) + offsetPx.x;
    const floaterY = ftToPx(event.y) + offsetPx.y;
    const text = scene.add.text(floaterX, floaterY, label, {
      fontFamily: FONT_FAMILY,
      fontSize,
      color,
      stroke: '#000000',
      strokeThickness: 2,
    });
    text.setOrigin(0.5, 1);
    // World-space VFX: depth must stay below UI_DEPTH_CUTOFF (see render-depths.ts).
    text.setDepth(WORLD_VFX_DEPTH.combatText);
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(text);

    floaters.push({
      obj: text,
      startMs: renderElapsedMs,
      startY: floaterY,
      durationMs: VFX_DURATION_MS,
      risePx: VFX_RISE_PX,
    });
  }

  function spawnAbilityFloater(
    event: AbilityActivationEvent,
    stackIndex: number,
    renderElapsedMs: number,
  ): void {
    const { label, color, fontSize } = abilityFloaterStyle(event);

    const floaterX = ftToPx(event.x);
    const floaterY =
      ftToPx(event.y) - ABILITY_VFX_BASE_OFFSET_PX - stackIndex * ABILITY_VFX_STACK_OFFSET_PX;
    const text = scene.add.text(floaterX, floaterY, label, {
      fontFamily: FONT_FAMILY,
      fontSize,
      color,
      stroke: '#000000',
      strokeThickness: 3,
    });
    text.setOrigin(0.5, 1);
    text.setDepth(WORLD_VFX_DEPTH.combatText);
    text.setName(`${ABILITY_FLOATER_NAME_PREFIX}${event.abilityId}`);
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(text);

    floaters.push({
      obj: text,
      startMs: renderElapsedMs,
      startY: floaterY,
      durationMs: ABILITY_VFX_DURATION_MS,
      risePx: ABILITY_VFX_RISE_PX,
    });
  }

  return {
    update(world: GameWorld, renderElapsedMs: number): void {
      // Spawn VFX for new events
      for (const event of world.combatEvents) {
        // `corpseExplode` is consumed by the shatter VFX, not shown as a damage
        // number — a corpse takes 0 actual damage, so a floater would mislead.
        if (event.type === 'corpseExplode') continue;
        spawnFloater(event, combatFloaterStyle(event), renderElapsedMs);
      }
      // Drain the queue — we are the sole consumer
      world.combatEvents.length = 0;

      // Non-combat floaters (skill level-ups). Spawned higher above the entity
      // so a "+1" never stacks on top of the damage number that earned it.
      const skillFloaterClusterCounts = new Map<string, number>();
      for (const event of world.floaterEvents) {
        const clusterKey = `${event.kind}:${event.x}:${event.y}`;
        const index = skillFloaterClusterCounts.get(clusterKey) ?? 0;
        skillFloaterClusterCounts.set(clusterKey, index + 1);
        spawnFloater(
          event,
          noticeFloaterStyle(event),
          renderElapsedMs,
          skillFloaterOffsetPx(index),
        );
      }
      world.floaterEvents.length = 0;

      // Ability-activation floaters (player-only; emitted by abilitySystem).
      world.abilityActivations.forEach((event, i) => {
        spawnAbilityFloater(event, i, renderElapsedMs);
      });
      world.abilityActivations.length = 0;

      // Animate and clean up existing floaters
      for (let i = floaters.length - 1; i >= 0; i--) {
        const f = floaters[i]!;
        const age = renderElapsedMs - f.startMs;
        const progress = Math.min(1, age / f.durationMs);

        if (progress >= 1) {
          f.obj.destroy();
          floaters.splice(i, 1);
          continue;
        }

        // Rise and fade
        f.obj.setY(f.startY - f.risePx * progress);
        f.obj.setAlpha(1 - progress * progress);
      }
    },

    destroy(): void {
      for (const f of floaters) {
        f.obj.destroy();
      }
      floaters.length = 0;
    },
  };
}
