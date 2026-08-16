/**
 * Pure argument parsing + help text for {@link ./headless-runner-cli.ts}.
 *
 * Extracted into a side-effect-free module so the parser can be unit-tested
 * without importing the CLI entrypoint (which runs `main()` at module load and
 * would kick off a full headless simulation on import).
 */
import { AIDecisionMode, AIPathingMode } from './types.js';
import type { AIDecisionModeValue, AIPathingModeValue, PlayerPersona } from './types.js';
import { ENEMY_PROJECTILE } from '../../shared/constants.js';
import { DEFAULT_CONFIG } from './bt-ai-tuning.js';
import { FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES } from './floor-run-budget.js';
import { PLAYER_PERSONAS } from './personas.js';

export interface CLIArgs {
  seed: number;
  maxFrames: number;
  maxTimeMs: number;
  progress: number;
  /**
   * Explicit `--aggression` override, or `null` when the flag was not supplied.
   * Nullable (rather than defaulting to 1) so an explicit `--aggression 1` is
   * still applied on top of a non-default persona preset.
   */
  aggression: number | null;
  debug: boolean;
  help: boolean;
  eventLog: string | null;
  eventSummary: string | null;
  sampleInterval: number;
  weapon: string | null;
  enemyDamageMultiplier: number;
  enemyTelegraphMs: number;
  floorId: string;
  startPlayerLevel: number;
  weaponTelemetry: boolean;
  weaponPersonas: boolean;
  pathingMode: AIPathingModeValue;
  decisionMode: AIDecisionModeValue;
  /** Single shared flag for both optional AI purchases (merchant weapon + Spell Broker). Default true. */
  optionalPurchases: boolean;
  settlementReturnRouting: boolean;
  persona: PlayerPersona;
}

const PATHING_MODE_VALUES = Object.values(AIPathingMode) as AIPathingModeValue[];
const DECISION_MODE_VALUES = Object.values(AIDecisionMode) as AIDecisionModeValue[];

export function defaultCLIArgs(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CLIArgs {
  const optionalPurchasesEnv = env.AI_OPTIONAL_PURCHASES ?? env.AI_MERCHANT_WEAPON_PURCHASE;
  return {
    seed: 12345,
    maxFrames: FLOOR_AGNOSTIC_DEFAULT_MAX_FRAMES,
    maxTimeMs: 5 * 60 * 1000,
    progress: 3600, // Report every minute of game time
    aggression: null,
    debug: false,
    help: false,
    eventLog: null,
    eventSummary: null,
    sampleInterval: 15,
    weapon: null,
    enemyDamageMultiplier: 1,
    enemyTelegraphMs: ENEMY_PROJECTILE.TELEGRAPH_MS,
    floorId: 'floor1',
    startPlayerLevel: 1,
    weaponTelemetry: false,
    weaponPersonas: true,
    // Kept in sync with the game-runtime DEFAULT_CONFIG (bt-ai-tuning.ts) so the
    // manual `npm run ai:headless` CLI matches production unless a caller
    // explicitly passes --pathing-mode/--decision-mode.
    pathingMode: DEFAULT_CONFIG.pathingMode,
    decisionMode: DEFAULT_CONFIG.decisionMode,
    // Legacy env var still honoured so existing scripts keep working.
    optionalPurchases:
      optionalPurchasesEnv === undefined ||
      optionalPurchasesEnv === '1' ||
      optionalPurchasesEnv.toLowerCase() === 'true',
    settlementReturnRouting:
      env.AI_SETTLEMENT_RETURN_ROUTING === '1' ||
      env.AI_SETTLEMENT_RETURN_ROUTING?.toLowerCase() === 'true',
    persona: 'experienced_player',
  };
}

/**
 * Parse CLI flags into a fully-defaulted {@link CLIArgs}. Accepts the raw
 * process argv (defaults to `process.argv`); tokens 0/1 (node + script) are
 * skipped so callers can pass a real `process.argv` array unchanged.
 */
export function parseArgs(
  argv: readonly string[] = process.argv,
  env: Readonly<Record<string, string | undefined>> = process.env,
): CLIArgs {
  const args = defaultCLIArgs(env);

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--seed' && next) {
      args.seed = parseInt(next, 10);
      i++;
    } else if (arg === '--max-frames' && next) {
      args.maxFrames = parseInt(next, 10);
      i++;
    } else if (arg === '--max-time-ms' && next) {
      args.maxTimeMs = parseInt(next, 10);
      i++;
    } else if (arg === '--progress' && next) {
      args.progress = parseInt(next, 10);
      i++;
    } else if (arg === '--aggression' && next) {
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --aggression "${next}" (must be a finite number)`);
      }
      args.aggression = parsed;
      i++;
    } else if (arg === '--event-log' && next) {
      args.eventLog = next;
      i++;
    } else if (arg === '--event-summary' && next) {
      args.eventSummary = next;
      i++;
    } else if (arg === '--sample-interval' && next) {
      args.sampleInterval = Math.max(1, parseInt(next, 10));
      i++;
    } else if (arg === '--weapon' && next) {
      args.weapon = next;
      i++;
    } else if (arg === '--enemy-damage-multiplier' && next) {
      const parsed = Number.parseFloat(next);
      if (!Number.isFinite(parsed)) {
        throw new Error(`Invalid --enemy-damage-multiplier "${next}" (must be a finite number)`);
      }
      args.enemyDamageMultiplier = parsed;
      i++;
    } else if (arg === '--enemy-telegraph-ms') {
      // Regression: copilot-pull-request-reviewer finding — the previous
      // `arg === '--enemy-telegraph-ms' && next` guard silently skipped this
      // whole branch (falling through with no error) when the flag was the
      // final token, letting a malformed invocation run with the 250ms
      // default instead of failing fast. Handle the flag unconditionally and
      // reject a missing/blank value explicitly.
      if (next === undefined || next.trim() === '') {
        throw new Error('--enemy-telegraph-ms requires a value (e.g. --enemy-telegraph-ms 250)');
      }
      const parsed = Number(next);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new Error(`Invalid --enemy-telegraph-ms "${next}" (must be a finite number >= 0)`);
      }
      args.enemyTelegraphMs = parsed;
      i++;
    } else if (arg === '--floor' && next) {
      args.floorId = next;
      i++;
    } else if (arg === '--start-level' && next) {
      const parsed = parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error(`Invalid --start-level "${next}" (must be a positive integer)`);
      }
      args.startPlayerLevel = parsed;
      i++;
    } else if (arg === '--weapon-telemetry') {
      args.weaponTelemetry = true;
    } else if (arg === '--weapon-personas') {
      args.weaponPersonas = true;
    } else if (arg === '--no-weapon-personas') {
      args.weaponPersonas = false;
    } else if (arg === '--optional-purchases') {
      args.optionalPurchases = true;
    } else if (arg === '--no-optional-purchases') {
      args.optionalPurchases = false;
    } else if (arg === '--merchant-weapon-purchase') {
      // Legacy alias: kept for backward compatibility with existing scripts.
      args.optionalPurchases = true;
    } else if (arg === '--settlement-return-routing') {
      args.settlementReturnRouting = true;
    } else if (arg === '--persona') {
      // Handle unconditionally (no `&& next` guard) so a trailing `--persona`
      // fails fast instead of silently running as `experienced_player` and
      // mislabelling the playtest.
      if (next === undefined || next.trim() === '') {
        throw new Error(
          `--persona requires a value (must be one of: ${PLAYER_PERSONAS.join(', ')})`,
        );
      }
      if (!(PLAYER_PERSONAS as readonly string[]).includes(next)) {
        throw new Error(
          `Invalid --persona "${next}" (must be one of: ${PLAYER_PERSONAS.join(', ')})`,
        );
      }
      args.persona = next as PlayerPersona;
      i++;
    } else if (arg === '--pathing-mode' && next) {
      if (!(PATHING_MODE_VALUES as string[]).includes(next)) {
        throw new Error(
          `Invalid --pathing-mode "${next}" (must be one of: ${PATHING_MODE_VALUES.join(', ')})`,
        );
      }
      args.pathingMode = next as AIPathingModeValue;
      i++;
    } else if (arg === '--decision-mode' && next) {
      if (!(DECISION_MODE_VALUES as string[]).includes(next)) {
        throw new Error(
          `Invalid --decision-mode "${next}" (must be one of: ${DECISION_MODE_VALUES.join(', ')})`,
        );
      }
      args.decisionMode = next as AIDecisionModeValue;
      i++;
    } else if (arg === '--debug') {
      args.debug = true;
    }
  }

  return args;
}

export function helpText(): string {
  const defaultPathingMode = DEFAULT_CONFIG.pathingMode;
  return `
Headless AI Runner CLI

Usage:
  node src/game/ai/headless-runner-cli.js [options]

Options:
  --seed <number>         Random seed (default: 12345)
  --max-frames <number>   Maximum frames to simulate (default: 100000)
  --max-time-ms <number>  Maximum wall-clock time in ms (default: 300000)
  --progress <number>     Report progress every N frames (default: 3600)
  --aggression <number>   AI aggression override 0-2 (default: the --persona value)
  --weapon <id>           Force a specific starting weapon (e.g. sword, bow, baseball-bat)
  --event-log <path>      Write per-frame telemetry as JSONL to <path>
  --event-summary <path>  Write wasted-time summary JSON to <path>
  --sample-interval <n>   Frames between telemetry samples (default: 15)
  --debug                 Enable verbose logging
  --enemy-damage-multiplier <n>
                           Multiply hostile Damage values (default: 1)
  --enemy-telegraph-ms <n>
                           Delay (ms) enemy projectiles telegraph before firing;
                           0 disables the cue and fires immediately (default: ${ENEMY_PROJECTILE.TELEGRAPH_MS})
  --floor <id>            Scenario floor id (default: floor1)
  --start-level <n>       Start at player character level N (default: 1, no boost)
  --weapon-telemetry      Collect + print per-run weapon accuracy (swings, hits, multi-hit)
  --weapon-personas       Enable weapon-specific stat/gear personas (default)
  --no-weapon-personas    Disable weapon personas for the legacy A/B control
  --optional-purchases    Enable both optional AI purchases: post-quest merchant weapon
                           purchase and Floor 1 Spell Broker purchase (default: on)
  --no-optional-purchases Disable both optional AI purchases for the A/B control
                           Legacy alias: --merchant-weapon-purchase (same effect)
                           Env: AI_OPTIONAL_PURCHASES=1 (or AI_MERCHANT_WEAPON_PURCHASE=1)
  --settlement-return-routing
                           Enable optional latched AI settlement-return route goal
                           (deterministic expected-gain-vs-travel/risk/opportunity
                           utility; periodically returns to settlement to run the
                           maintenance planner — equip/shop/claim/abilities)
  --pathing-mode <mode>   AI pathing A/B axis: riskRewardFused (default: ${defaultPathingMode})
  --decision-mode <mode>  AI decision A/B axis: legacy (default: legacy)
  --persona <name>         Evaluator persona (default: experienced_player)
                           new_player, experienced_player, min_max_cheeser, explorer
  --help, -h              Show this help message

Examples:
  # Quick test run
  node src/game/ai/headless-runner-cli.js --seed 42 --max-frames 10000

  # Long aggressive run with progress updates
  node src/game/ai/headless-runner-cli.js --seed 99 --aggression 2 --progress 1800

  # Capture an event log + wasted-time summary for analysis
  node src/game/ai/headless-runner-cli.js --seed 42 --max-frames 7200 \\
    --event-log run.jsonl --event-summary run-summary.json
`;
}
