/**
 * Floor 3 Companion League — onboarding / starter / poach UX presentation
 * models (spec `.specify/specs/floor3-companion-league.md` slice 12; UX
 * surfaces #1–#3 in `docs/knowledge/game-design/floor3-companion-league.md`
 * §15).
 *
 * Pure and deterministic: every builder maps species ids + party state to a
 * `ModalPickerConfig`, so `MainGameScene` and `floor3-ux-lab` render byte
 * identical copy and the surfaces are unit-testable without Phaser.
 */
import { formForLevel, getPetSpecies, type PetSpeciesDef } from './data/floor3/species.js';
import type { Floor3PoachCandidate } from './floor-types.js';
import type { ModalPickerConfig, ModalPickerOption } from './modal-picker.js';

/** Stable `kind` ids so automation can tell the three Floor 3 surfaces apart. */
const FLOOR3_INTRO_PICKER_KIND = 'floor3-intro';
const FLOOR3_STARTER_PICKER_KIND = 'floor3-starter';
const FLOOR3_POACH_PICKER_KIND = 'floor3-poach';
const FLOOR3_STUDIO_VERSUS_KIND = 'floor3-studio-versus';
const FLOOR3_FINAL_FOUR_VERSUS_KIND = 'floor3-final-four-versus';
const FLOOR3_KEEP_COMPANION_KIND = 'floor3-keep-companion';

/** Option id of the intro screen's single acknowledgement button. */
const FLOOR3_INTRO_ACKNOWLEDGE_ID = 'floor3-intro-ack';

/**
 * The rules the welcome screen has to teach (UX surface #1): the show format,
 * that the player never fights, how recruiting and the party lock work, and
 * the win condition.
 */
const FLOOR3_INTRO_RULES: readonly string[] = [
  'The format: you are a Wrangler in the Companion League. Your Companions battle; you command.',
  'You never fight. Wranglers and handlers are insured non-combatants — only Companions take damage.',
  'Recruit: pick 1 starter now, then poach 1 Companion from every Trainer you beat.',
  'The lock: starter + 5 poaches = 6 Companions, then your roster signs for the season.',
  'Win it: beat all Studios, then take the Final Four to be named Best in Show.',
];

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** `Affinity · Style · Innate ability` — the read every picker row needs. */
function describeSpecies(species: PetSpeciesDef): string {
  return `${capitalize(species.affinity)} · ${capitalize(species.fightingStyle)} · ${species.innateAbilityName}`;
}

function speciesOption(speciesId: string, index: number, level: number): ModalPickerOption {
  const species = getPetSpecies(speciesId);
  if (!species) {
    return { id: speciesId, label: `Option ${index + 1}`, description: speciesId };
  }
  const form = formForLevel(species, level);
  const levelSuffix = level > 1 ? ` · Lv ${level}` : '';
  return {
    id: speciesId,
    label: form.name,
    description: `${describeSpecies(species)}${levelSuffix}`,
  };
}

/** Floor 3 welcome + rules screen (UX #1) as a single-acknowledgement picker. */
export function buildFloor3IntroModel(): ModalPickerConfig {
  return {
    kind: FLOOR3_INTRO_PICKER_KIND,
    title: 'Welcome to the Companion League',
    subtitle: 'Floor 3 · Season rules briefing',
    body: FLOOR3_INTRO_RULES.join('\n'),
    options: [
      {
        id: FLOOR3_INTRO_ACKNOWLEDGE_ID,
        label: "Let's meet the starters",
        description: 'Acknowledge the rules and open the starter offer.',
      },
    ],
    allowCancel: false,
    initialSelectedId: FLOOR3_INTRO_ACKNOWLEDGE_ID,
  };
}

/** Starter-Companion offer (UX #2): the seeded 4-species pick at floor entry. */
export function buildFloor3StarterPickerModel(
  offerSpeciesIds: readonly string[],
): ModalPickerConfig {
  return {
    kind: FLOOR3_STARTER_PICKER_KIND,
    title: 'Choose your starter Companion',
    subtitle: 'Floor 3 is paused until you confirm a starter.',
    body: 'Pick the Companion you want to begin the Companion League with.',
    options: offerSpeciesIds.map((speciesId, index) => speciesOption(speciesId, index, 1)),
    allowCancel: true,
    ...(offerSpeciesIds[0] !== undefined ? { initialSelectedId: offerSpeciesIds[0] } : {}),
  };
}

export interface Floor3PoachPickerParams {
  /**
   * The defeated Trainer's Companions, in offer order. Each candidate carries
   * its own level (a Trainer can field species at different levels), so every
   * row renders the form and level the player would actually recruit.
   */
  readonly candidates: readonly Floor3PoachCandidate[];
  /** Recruit slots left before the party locks (this pick included). */
  readonly slotsRemaining: number;
  /** Display name of the defeated Trainer/Studio, when known. */
  readonly trainerName?: string;
}

/**
 * Poach-a-Companion picker (UX #3): the defeated Trainer's roster, the recruit
 * slots left, and the party-lock warning on the pick that signs the roster
 * (game-design §6.3 — the 5th poach fills the 6-Companion party and locks it).
 */
export function buildFloor3PoachPickerModel(params: Floor3PoachPickerParams): ModalPickerConfig {
  const { candidates, slotsRemaining, trainerName } = params;
  const locksRoster = slotsRemaining <= 1;
  const slotsText = locksRoster
    ? 'This is your final recruit slot.'
    : `${slotsRemaining} recruit slots remaining.`;
  const lockWarning = locksRoster
    ? '\nThis signs your roster for the season — no more recruiting.'
    : '';
  return {
    kind: FLOOR3_POACH_PICKER_KIND,
    title: 'Poach a Companion',
    subtitle: trainerName
      ? `${trainerName} is beaten — claim one of their Companions.`
      : 'Trainer beaten — claim one of their Companions.',
    body: `${slotsText}${lockWarning}`,
    options: candidates.map((candidate, index) =>
      speciesOption(candidate.speciesId, index, candidate.level),
    ),
    allowCancel: true,
    ...(candidates[0] !== undefined ? { initialSelectedId: candidates[0].speciesId } : {}),
  };
}

export interface Floor3LeagueStudioView {
  readonly id: string;
  readonly name: string;
  readonly affinity?: string;
  readonly unlockLevel: number;
  readonly unlocked: boolean;
  readonly defeated: boolean;
}

export interface Floor3LeagueRoundView {
  readonly handlerId: string;
  readonly handlerName: string;
  readonly defeated: boolean;
}

export interface Floor3LeagueViewModel {
  readonly visible: boolean;
  readonly phase: 'studios' | 'final-four' | 'best-in-show' | 'lost';
  readonly studiosDefeated: number;
  readonly studioCount: number;
  readonly studios: readonly Floor3LeagueStudioView[];
  readonly rounds: readonly Floor3LeagueRoundView[];
  readonly activeRoundIndex: number | null;
  readonly headline: string;
  readonly detail: string;
}

export interface Floor3LeagueViewInput {
  readonly floorId: string | null;
  readonly worldState: string;
  readonly victory: boolean;
  readonly studiosDefeated: number;
  readonly studios: readonly Floor3LeagueStudioView[];
  readonly finalFourUnlocked: boolean;
  readonly finalFourRoundIndex: number;
  readonly rounds: readonly Floor3LeagueRoundView[];
}

/** Pure projection for the persistent Studio / Final Four bracket HUD. */
export function buildFloor3LeagueViewModel(input: Floor3LeagueViewInput): Floor3LeagueViewModel {
  const visible = input.floorId === 'floor3' && input.studios.length > 0;
  const activeRoundIndex =
    input.finalFourUnlocked && input.finalFourRoundIndex < input.rounds.length
      ? input.finalFourRoundIndex
      : null;
  const phase: Floor3LeagueViewModel['phase'] =
    input.worldState === 'game_over' && !input.victory
      ? 'lost'
      : input.victory
        ? 'best-in-show'
        : input.finalFourUnlocked
          ? 'final-four'
          : 'studios';
  const activeHandler =
    activeRoundIndex === null ? undefined : input.rounds[activeRoundIndex]?.handlerName;
  return {
    visible,
    phase,
    studiosDefeated: input.studiosDefeated,
    studioCount: input.studios.length,
    studios: input.studios,
    rounds: input.rounds,
    activeRoundIndex,
    headline:
      phase === 'best-in-show'
        ? 'BEST IN SHOW'
        : phase === 'lost'
          ? 'SEASON OVER'
          : phase === 'final-four'
            ? `FINAL FOUR · ROUND ${(activeRoundIndex ?? input.rounds.length - 1) + 1}/${input.rounds.length}`
            : `STUDIOS · ${input.studiosDefeated}/${input.studios.length}`,
    detail:
      phase === 'best-in-show'
        ? 'Choose the Companion who leaves with you.'
        : phase === 'lost'
          ? 'Your party was wiped. Rebuild and rally.'
          : activeHandler
            ? `Your party vs ${activeHandler}`
            : 'Defeat every Studio to open the championship gate.',
  };
}

export function buildFloor3StudioVersusModel(
  studio: Floor3LeagueStudioView,
): ModalPickerConfig {
  const affinity = studio.affinity ? `${capitalize(studio.affinity)} affinity · ` : '';
  return {
    kind: FLOOR3_STUDIO_VERSUS_KIND,
    title: `${studio.name} unlocked`,
    subtitle: `STUDIO VERSUS · Your party vs ${studio.name}`,
    body: `${affinity}Level ${studio.unlockLevel} gate cleared.\nPreview the roster, then send in your Companions.`,
    options: [{ id: 'continue', label: 'Enter the Studio', description: 'Begin the matchup.' }],
    allowCancel: false,
    initialSelectedId: 'continue',
  };
}

export function buildFloor3FinalFourVersusModel(
  round: Floor3LeagueRoundView,
  roundIndex: number,
  roundCount: number,
): ModalPickerConfig {
  return {
    kind: FLOOR3_FINAL_FOUR_VERSUS_KIND,
    title: `Final Four · Round ${roundIndex + 1} of ${roundCount}`,
    subtitle: `Your party vs ${round.handlerName}`,
    body: `Gauntlet bracket: ${roundIndex} cleared · ${roundCount - roundIndex} remaining.\nWin this round to advance to the next seeded finalist.`,
    options: [{ id: 'continue', label: 'Begin the round', description: 'Return to the arena.' }],
    allowCancel: false,
    initialSelectedId: 'continue',
  };
}

export interface Floor3KeepCompanionOption {
  readonly eid: number;
  readonly speciesId: string;
  readonly currentName: string;
  readonly ultimateName: string;
  readonly level: number;
  readonly affinity: string;
  readonly fightingStyle: string;
}

/** Required season-win choice; option ids retain the live eid for the injected game callback. */
export function buildFloor3KeepCompanionPickerModel(
  companions: readonly Floor3KeepCompanionOption[],
): ModalPickerConfig {
  return {
    kind: FLOOR3_KEEP_COMPANION_KIND,
    title: 'Best in Show',
    subtitle: 'Champion crowned · Keep one Companion before you exit',
    body: 'Your season roster parts ways here. Select the one Companion who carries forward at ultimate form.',
    options: companions.map((companion) => ({
      id: String(companion.eid),
      label: `${companion.currentName} · Lv ${companion.level}`,
      description: `${capitalize(companion.affinity)} · ${capitalize(companion.fightingStyle)} · Ultimate: ${companion.ultimateName}`,
    })),
    allowCancel: false,
    ...(companions[0] ? { initialSelectedId: String(companions[0].eid) } : {}),
  };
}

export function buildFloor3LoseModel(): ModalPickerConfig {
  return {
    kind: 'floor3-party-wipe',
    title: 'Season Over',
    subtitle: 'Your Companion party was wiped.',
    body: 'The broadcast cuts to black. Rebuild your roster, use Rally Points, and challenge the circuit again.',
    options: [
      { id: 'restart', label: '↺ Restart', description: 'Start the Companion League again.' },
      { id: 'quit', label: '← Quit', description: 'Return to the title screen.' },
    ],
    allowCancel: false,
    initialSelectedId: 'restart',
  };
}
