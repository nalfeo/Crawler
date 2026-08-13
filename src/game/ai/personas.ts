import type { AIConfig, PlayerPersona } from './types.js';

export const PLAYER_PERSONAS: readonly PlayerPersona[] = [
  'new_player',
  'experienced_player',
  'min_max_cheeser',
  'explorer',
];

const PERSONA_CONFIGS: Readonly<Record<PlayerPersona, Omit<AIConfig, 'seed' | 'debug'>>> = {
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
  experienced_player: {
    aggression: 1,
    retreatThreshold: 0.1,
    retreatDangerRadius: 20,
    scanRadius: 50,
    rangedSafeDistance: 15,
    opportunisticGrabRadius: 18,
    dodgeWeight: 0.25,
    collectPullWeight: 0.5,
    farmPullWeight: 0.12,
  },
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

export function getPersonaConfig(persona: PlayerPersona): Omit<AIConfig, 'seed' | 'debug'> {
  return { ...PERSONA_CONFIGS[persona] };
}
