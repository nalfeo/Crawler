import { RUNNER_PERSONA, type AIConfig, type RunnerPersonaValue } from './types.js';

export interface RunnerPersonaProfile {
  readonly id: RunnerPersonaValue;
  readonly label: string;
  readonly description: string;
  readonly farmAfterStairUnlock: boolean;
  readonly stairDescendWindowMs: number;
  readonly aiConfigOverrides: Partial<AIConfig>;
}

const RUNNER_PERSONA_PROFILES: Record<RunnerPersonaValue, RunnerPersonaProfile> = {
  [RUNNER_PERSONA.SPEEDY]: {
    id: RUNNER_PERSONA.SPEEDY,
    label: 'Speedy',
    description: 'Clears the floor as fast as possible while prioritizing survival.',
    farmAfterStairUnlock: false,
    stairDescendWindowMs: Number.POSITIVE_INFINITY,
    aiConfigOverrides: {},
  },
  [RUNNER_PERSONA.BALANCED]: {
    id: RUNNER_PERSONA.BALANCED,
    label: 'Balanced',
    description: 'Balances clear speed with extra combat/loot value when safe.',
    farmAfterStairUnlock: true,
    // Farm for up to ~1 minute after staircase unlock, then exit safely.
    stairDescendWindowMs: 60_000,
    aiConfigOverrides: {
      aggression: 1,
      scanRadius: 52,
      collectPullWeight: 0.5,
      farmPullWeight: 0.09,
      retreatThreshold: 0.17,
    },
  },
  [RUNNER_PERSONA.GREEDY]: {
    id: RUNNER_PERSONA.GREEDY,
    label: 'Greedy',
    description: 'Expert farmer maximizing kills, XP, and gold before exiting safely.',
    farmAfterStairUnlock: true,
    // Push farming longer and only descend in the final ~20 seconds.
    stairDescendWindowMs: 20_000,
    aiConfigOverrides: {
      aggression: 1.2,
      scanRadius: 58,
      collectPullWeight: 0.7,
      farmPullWeight: 0.16,
      retreatThreshold: 0.13,
    },
  },
};

export function parseRunnerPersona(input: string | null | undefined): RunnerPersonaValue | null {
  if (!input) return null;
  const normalized = input.trim().toLowerCase();
  for (const id of Object.values(RUNNER_PERSONA)) {
    if (normalized === id) {
      return id;
    }
  }
  return null;
}

export function getRunnerPersonaProfile(persona: RunnerPersonaValue): RunnerPersonaProfile {
  return RUNNER_PERSONA_PROFILES[persona];
}

function resolveRunnerPersona(persona: RunnerPersonaValue | null | undefined): RunnerPersonaValue {
  return persona ?? RUNNER_PERSONA.SPEEDY;
}

export function applyRunnerPersonaToConfig(config: AIConfig): AIConfig {
  const persona = resolveRunnerPersona(config.runnerPersona);
  const profile = getRunnerPersonaProfile(persona);
  return {
    ...profile.aiConfigOverrides,
    ...config,
    runnerPersona: persona,
  };
}

/**
 * Whether a runner should descend immediately when standing on the staircase
 * marker. `null`/`undefined` personas intentionally resolve to `speedy` to keep
 * legacy immediate-exit behavior for older call sites.
 */
export function shouldDescendAtStairs(
  persona: RunnerPersonaValue | null | undefined,
  timeRemainingMs: number,
): boolean {
  if (!Number.isFinite(timeRemainingMs)) {
    return true;
  }
  const profile = getRunnerPersonaProfile(resolveRunnerPersona(persona));
  return timeRemainingMs <= profile.stairDescendWindowMs;
}
