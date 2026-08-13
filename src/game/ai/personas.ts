import { DEFAULT_CONFIG } from './bt-ai-tuning.js';
import type { AIConfig, PlayerPersona } from './types.js';

/** Persona preset shape: every tunable knob except the run-scoped seed/debug. */
export type PersonaConfig = Omit<AIConfig, 'seed' | 'debug'>;

export const PLAYER_PERSONAS: readonly PlayerPersona[] = [
  'new_player',
  'experienced_player',
  'min_max_cheeser',
  'explorer',
];

/**
 * `experienced_player` is the production baseline cohort, so it is derived
 * from {@link DEFAULT_CONFIG} by construction rather than re-typed here — a
 * copied literal can drift the moment production tuning is re-promoted.
 */
const EXPERIENCED_PLAYER_CONFIG: PersonaConfig = (() => {
  const { seed: _seed, debug: _debug, ...tuning } = DEFAULT_CONFIG;
  return tuning;
})();

const PERSONA_CONFIGS: Readonly<Record<PlayerPersona, PersonaConfig>> = {
  new_player: {
    aggression: 0.55,
    retreatThreshold: 0.45,
    retreatDangerRadius: 8,
    scanRadius: 7,
    rangedSafeDistance: 5,
    opportunisticGrabRadius: 3,
    dodgeWeight: 0.9,
    collectPullWeight: 0.55,
    farmPullWeight: 0.05,
  },
  experienced_player: EXPERIENCED_PLAYER_CONFIG,
  min_max_cheeser: {
    aggression: 1.8,
    retreatThreshold: 0.12,
    retreatDangerRadius: 12,
    scanRadius: 14,
    rangedSafeDistance: 4,
    opportunisticGrabRadius: 7,
    dodgeWeight: 0.35,
    collectPullWeight: 0.15,
    farmPullWeight: 0.45,
  },
  explorer: {
    aggression: 0.8,
    retreatThreshold: 0.3,
    retreatDangerRadius: 9,
    scanRadius: 9,
    rangedSafeDistance: 6,
    opportunisticGrabRadius: 6,
    dodgeWeight: 0.75,
    collectPullWeight: 0.75,
    farmPullWeight: 0.2,
  },
};

export function getPersonaConfig(persona: PlayerPersona): PersonaConfig {
  return { ...PERSONA_CONFIGS[persona] };
}

/**
 * Knobs the headless CLI can override on top of a persona preset. Any
 * divergence here means the run no longer behaves like the named cohort.
 */
export type PersonaOverrides = Partial<
  Pick<PersonaConfig, 'aggression' | 'pathingMode' | 'decisionMode'>
>;

/**
 * Return the persona knobs that `overrides` actually changes, sorted for
 * deterministic reporting. A run with a non-empty result must NOT be labelled
 * with the persona: grouping it into that cohort would contaminate
 * `persona_scores` and every downstream comparison with behavior the persona
 * never had.
 */
export function personaConfigDivergence(
  persona: PlayerPersona,
  overrides: PersonaOverrides,
): string[] {
  const baseline: PersonaConfig = { ...EXPERIENCED_PLAYER_CONFIG, ...PERSONA_CONFIGS[persona] };
  const keys = ['aggression', 'pathingMode', 'decisionMode'] as const;
  return keys
    .filter((key) => overrides[key] !== undefined && overrides[key] !== baseline[key])
    .sort();
}
