/**
 * Boss intro content — the lore sheet The Director cuts to the moment a boss
 * battle starts.
 *
 * Pure content + resolution only: this module knows nothing about Phaser, the
 * ECS world, or how the sheet is rendered. `src/engine/boss-intro-state.ts`
 * decides *when* an intro fires; `src/engine/BossIntroUI.ts` draws it.
 *
 * Two content sources, one shape:
 *  - Floor 1's two scripted bosses are hand-authored below (they are the
 *    tutorial beats, so their copy is bespoke).
 *  - Floor 2's family den bosses are derived deterministically from the family
 *    roster in `data/families.json`, so adding a family automatically gets a
 *    correctly-billed intro instead of silently shipping an unnamed boss.
 */
import { loadFamilies, type FamilyDef } from './data/families.js';

/** Everything the lore sheet needs to present one boss. */
export interface BossIntroContent {
  /** Stable identity of this intro; also the "already shown" dedupe key. */
  readonly introId: string;
  /** Boss name, e.g. `Rat Slime`. */
  readonly name: string;
  /** Billing above the name, e.g. `Floor Boss`. */
  readonly title: string;
  /** Optional smaller line under the name (faction/species framing). */
  readonly subtitle: string;
  /**
   * The Director's on-air producer commentary. Rendered as separate paragraphs,
   * so keep each line short enough to read at a glance.
   */
  readonly flavorLines: readonly string[];
  /** Render-kind token used to resolve the portrait sprite in the engine. */
  readonly renderKind: string;
  /** Accent colour (0xRRGGBB) for the sheet's frame and title rule. */
  readonly accentColor: number;
}

/** Default accent used when a boss has no faction colour of its own. */
const DEFAULT_ACCENT = 0xffc65c;

/** Floor 1's scripted bosses, keyed by their `objective.bossBattles` key. */
const FLOOR1_BOSS_INTROS: Readonly<Record<string, BossIntroContent>> = {
  'slime-rat': {
    introId: 'floor1:slime-rat',
    name: 'Slime Rat',
    title: 'Mid-Season Guest Star',
    subtitle: 'Neighborhood vermin · sponsored segment',
    flavorLines: [
      'THE DIRECTOR: "Cut to the rat. Audience loves the rat."',
      'Focus-grouped as "disgusting but relatable." It has been fed exclusively on the spell broker\'s expired inventory, which is either a tragedy or a marketing decision — legal is still deciding.',
      'Kill it fast and the highlight reel writes itself. Kill it slow and we sell the same footage twice.',
    ],
    renderKind: 'enemy_boss_slimerat',
    accentColor: 0x67d16b,
  },
  staircase: {
    introId: 'floor1:staircase',
    name: 'Rat Slime',
    title: 'Floor One Finale',
    subtitle: 'Stairwell custodian · contractually undefeated',
    flavorLines: [
      'THE DIRECTOR: "Everybody quiet. This is the money shot."',
      'It guards the only staircase off this floor, which makes it less a monster and more a very hungry turnstile. Nineteen contestants have negotiated with it. Nineteen contestants are still down here.',
      'Ratings note: the audience has already been told you win. Please try not to embarrass the edit.',
    ],
    renderKind: 'enemy_boss_ratslime',
    accentColor: 0xef6b6b,
  },
};

/** Parse a `#RRGGBB` family HUD colour into a Phaser 0xRRGGBB number. */
function accentFromHudColor(hudColor: string): number {
  const parsed = Number.parseInt(hudColor.replace('#', ''), 16);
  return Number.isFinite(parsed) ? parsed : DEFAULT_ACCENT;
}

/** Build the Director's intro for one Floor 2 family den boss. */
function familyBossIntro(family: FamilyDef): BossIntroContent {
  return {
    introId: `floor2:${family.id}`,
    name: family.boss.name,
    title: `${family.boss.title} of ${family.name}`,
    subtitle: `${family.species} · ${family.signature}`,
    flavorLines: [
      `THE DIRECTOR: "Roll the den package. ${family.name}, live."`,
      `${family.species} outfit. They ${family.refinementStyle}, they brand it the ${family.signature}, and they have never once let a camera crew leave with the recipe.`,
      `${family.boss.name} holds the ${family.boss.title.toLowerCase()} seat. Take that seat and every other family on this floor updates their opinion of you — some of them favourably.`,
    ],
    renderKind: 'enemy_family_boss',
    accentColor: accentFromHudColor(family.hudColor),
  };
}

let cachedFamilyIntros: ReadonlyMap<string, BossIntroContent> | null = null;

function familyIntros(): ReadonlyMap<string, BossIntroContent> {
  if (cachedFamilyIntros === null) {
    cachedFamilyIntros = new Map(
      loadFamilies().map((family) => [family.id, familyBossIntro(family)] as const),
    );
  }
  return cachedFamilyIntros;
}

/**
 * Intro content for a Floor 1 scripted boss (`objective.bossBattles` key), or
 * `null` when the key is unknown.
 */
export function floor1BossIntro(bossKey: string): BossIntroContent | null {
  return FLOOR1_BOSS_INTROS[bossKey] ?? null;
}

/**
 * Intro content for a Floor 2 family den boss, or `null` when the family id is
 * not in the roster.
 */
export function familyBossIntroFor(familyId: string): BossIntroContent | null {
  return familyIntros().get(familyId) ?? null;
}

/**
 * Fallback intro for a boss with no authored content, so an unrecognised boss
 * still gets a sheet (with the boss's own HUD display name) rather than
 * silently skipping the pause. `displayName` comes from the encounter state.
 */
export function fallbackBossIntro(introId: string, displayName: string): BossIntroContent {
  return {
    introId,
    name: displayName,
    title: 'Unscheduled Segment',
    subtitle: 'No press kit · no rehearsal',
    flavorLines: [
      'THE DIRECTOR: "Who booked this? Nobody? Fine. Roll anyway."',
      `Research has nothing on ${displayName}. That is usually the audience's favourite kind of guest, and always the contestant's least favourite.`,
      'Improvise. We are live either way.',
    ],
    renderKind: 'enemy_boss',
    accentColor: DEFAULT_ACCENT,
  };
}

/** Test hook: drop the memoised family intro table. */
export function _resetBossIntroCache(): void {
  cachedFamilyIntros = null;
}
