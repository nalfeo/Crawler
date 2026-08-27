/**
 * hud-spell-skill-rows — pure row-selection logic for the spell-skill rows
 * appended to `HudSkillTracker`.
 *
 * Kept free of Phaser so it can be unit-tested directly (mirrors the
 * `ability-bar-flash-state.ts` pattern of separating pure HUD logic from
 * rendering). Given the player's equipped active abilities, picks which of
 * them map to a trackable spell skill, in equip order, capped to `maxRows`.
 */
import { getSpellSkillId } from '../shared/spell-skills.js';

export interface SpellSkillRowEntry {
  readonly spellId: string;
  readonly skillId: string;
}

export function selectSpellSkillRows(
  equippedActiveAbilityIds: readonly string[],
  maxRows: number,
): SpellSkillRowEntry[] {
  if (maxRows <= 0) return [];

  const rows: SpellSkillRowEntry[] = [];
  for (const spellId of equippedActiveAbilityIds) {
    if (rows.length >= maxRows) break;
    const skillId = getSpellSkillId(spellId);
    if (skillId === undefined) continue;
    rows.push({ spellId, skillId });
  }
  return rows;
}

/**
 * Total count of equipped active abilities that map to a trackable spell
 * skill (uncapped). Used to size the "+N more" overflow indicator when the
 * player has equipped more trackable spells than `HudSkillTracker` has rows
 * for, so the cap is visible rather than silent.
 */
export function countMatchingSpellSkills(equippedActiveAbilityIds: readonly string[]): number {
  let count = 0;
  for (const spellId of equippedActiveAbilityIds) {
    if (getSpellSkillId(spellId) !== undefined) count++;
  }
  return count;
}
