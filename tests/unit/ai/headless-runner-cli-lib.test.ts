/**
 * Unit tests for the headless-runner CLI argument parser (A/B axis flags).
 *
 * Imports the side-effect-free `-lib` module (NOT the CLI entrypoint, which
 * runs a full simulation via `main()` on import). Covers the new
 * `--pathing-mode` / `--decision-mode` flags plus default behavior.
 */

import { describe, expect, it } from 'vitest';
import {
  defaultCLIArgs,
  helpText,
  parseArgs,
} from '../../../src/game/ai/headless-runner-cli-lib.js';
import { DEFAULT_CONFIG } from '../../../src/game/ai/bt-ai-tuning.js';
import { getPersonaConfig } from '../../../src/game/ai/personas.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

// parseArgs skips argv[0] (node) and argv[1] (script), matching process.argv.
function cli(...flags: string[]): ReturnType<typeof parseArgs> {
  return parseArgs(['node', 'headless-runner-cli.js', ...flags], {});
}

describe('headless-runner-cli parseArgs — A/B mode flags', () => {
  it('defaults A/B axes to the production DEFAULT_CONFIG (pathing=riskRewardFused, decision=legacy)', () => {
    const args = cli();
    expect(args.pathingMode).toBe(AIPathingMode.RISK_REWARD_FUSED);
    expect(args.decisionMode).toBe(AIDecisionMode.LEGACY);
    expect(args).toEqual(defaultCLIArgs({}));
  });

  it('prints the current default pathing mode in help text', () => {
    expect(helpText()).toContain(`(default: ${defaultCLIArgs({}).pathingMode})`);
  });

  it('parses a valid --decision-mode', () => {
    expect(cli('--decision-mode', 'legacy').decisionMode).toBe(AIDecisionMode.LEGACY);
  });

  it('parses a valid --pathing-mode', () => {
    expect(cli('--pathing-mode', 'riskRewardFused').pathingMode).toBe(
      AIPathingMode.RISK_REWARD_FUSED,
    );
  });

  it('parses both axes together alongside other flags', () => {
    const args = cli(
      '--seed',
      '99',
      '--decision-mode',
      'legacy',
      '--pathing-mode',
      'riskRewardFused',
    );
    expect(args.seed).toBe(99);
    expect(args.decisionMode).toBe(AIDecisionMode.LEGACY);
    expect(args.pathingMode).toBe(AIPathingMode.RISK_REWARD_FUSED);
  });

  it('defaults weapon personas on and supports an explicit legacy control', () => {
    expect(cli().weaponPersonas).toBe(true);
    expect(cli('--weapon-personas').weaponPersonas).toBe(true);
    expect(cli('--no-weapon-personas').weaponPersonas).toBe(false);
  });

  it('defaults to the experienced evaluator persona and parses named personas', () => {
    expect(cli().persona).toBe('experienced_player');
    expect(cli('--persona', 'new_player').persona).toBe('new_player');
    expect(cli('--persona', 'min_max_cheeser').persona).toBe('min_max_cheeser');
  });

  it('keeps the experienced evaluator persona aligned with the production default AI config', () => {
    const experienced = getPersonaConfig('experienced_player');
    expect(experienced).toMatchObject({
      aggression: DEFAULT_CONFIG.aggression,
      retreatThreshold: DEFAULT_CONFIG.retreatThreshold,
      retreatDangerRadius: DEFAULT_CONFIG.retreatDangerRadius,
      scanRadius: DEFAULT_CONFIG.scanRadius,
      rangedSafeDistance: DEFAULT_CONFIG.rangedSafeDistance,
      opportunisticGrabRadius: DEFAULT_CONFIG.opportunisticGrabRadius,
      dodgeWeight: DEFAULT_CONFIG.dodgeWeight,
      collectPullWeight: DEFAULT_CONFIG.collectPullWeight,
      farmPullWeight: DEFAULT_CONFIG.farmPullWeight,
    });
  });

  it('rejects unknown evaluator personas', () => {
    expect(() => cli('--persona', 'speedrunner')).toThrow(/Invalid --persona/);
  });

  it('rejects a --persona flag with no value instead of silently defaulting', () => {
    expect(() => cli('--persona')).toThrow(/--persona requires a value/);
    expect(() => cli('--persona', '  ')).toThrow(/--persona requires a value/);
  });

  it('consumes the persona value so it is not reparsed as a flag', () => {
    const args = cli('--persona', 'explorer', '--seed', '77');
    expect(args.persona).toBe('explorer');
    expect(args.seed).toBe(77);
  });

  it('treats --aggression as an unset override unless explicitly supplied', () => {
    expect(cli().aggression).toBeNull();
    // An explicit `--aggression 1` must still be applied (it used to be
    // indistinguishable from the old default of 1 and silently dropped).
    expect(cli('--aggression', '1').aggression).toBe(1);
    expect(cli('--aggression', '1.8').aggression).toBe(1.8);
    expect(() => cli('--aggression', 'hot')).toThrow(/Invalid --aggression/);
  });

  it('throws on an invalid --decision-mode', () => {
    expect(() => cli('--decision-mode', 'bogus')).toThrow(/Invalid --decision-mode/);
  });

  it('throws on an invalid --pathing-mode', () => {
    expect(() => cli('--pathing-mode', 'bogus')).toThrow(/Invalid --pathing-mode/);
  });

  it('keeps optionalPurchases off by default and enables via --optional-purchases flag or env', () => {
    expect(cli().optionalPurchases).toBe(false);
    expect(cli('--optional-purchases').optionalPurchases).toBe(true);
    // New canonical env var
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_OPTIONAL_PURCHASES: '1' })
        .optionalPurchases,
    ).toBe(true);
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_OPTIONAL_PURCHASES: 'true' })
        .optionalPurchases,
    ).toBe(true);
    // Legacy --merchant-weapon-purchase flag is still honoured (backward compat)
    expect(cli('--merchant-weapon-purchase').optionalPurchases).toBe(true);
    // Legacy env var is still honoured
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_MERCHANT_WEAPON_PURCHASE: 'true' })
        .optionalPurchases,
    ).toBe(true);
  });

  it('keeps settlement return routing off by default and enables it by flag or environment', () => {
    expect(cli().settlementReturnRouting).toBe(false);
    expect(cli('--settlement-return-routing').settlementReturnRouting).toBe(true);
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_SETTLEMENT_RETURN_ROUTING: '1' })
        .settlementReturnRouting,
    ).toBe(true);
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_SETTLEMENT_RETURN_ROUTING: 'true' })
        .settlementReturnRouting,
    ).toBe(true);
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_SETTLEMENT_RETURN_ROUTING: 'false' })
        .settlementReturnRouting,
    ).toBe(false);
  });
});

describe('headless-runner-cli parseArgs — --enemy-telegraph-ms', () => {
  it('defaults to 250ms (production/headless default)', () => {
    expect(cli().enemyTelegraphMs).toBe(250);
    expect(defaultCLIArgs({}).enemyTelegraphMs).toBe(250);
  });

  it('parses an explicit --enemy-telegraph-ms override', () => {
    expect(cli('--enemy-telegraph-ms', '500').enemyTelegraphMs).toBe(500);
  });

  it('accepts an explicit 0 (legacy parity), not treated as unset', () => {
    expect(cli('--enemy-telegraph-ms', '0').enemyTelegraphMs).toBe(0);
  });

  it('throws on a negative --enemy-telegraph-ms', () => {
    expect(() => cli('--enemy-telegraph-ms', '-5')).toThrow(/Invalid --enemy-telegraph-ms/);
  });

  it('throws on a non-numeric --enemy-telegraph-ms', () => {
    expect(() => cli('--enemy-telegraph-ms', 'bogus')).toThrow(/Invalid --enemy-telegraph-ms/);
  });

  it('throws on a malformed value with a numeric prefix (regression: copilot-pull-request-reviewer finding)', () => {
    // Number.parseFloat('250ms') === 250 -- it stops at the first non-numeric
    // character instead of rejecting the whole token, silently accepting
    // malformed CLI input. Number('250ms') is NaN, correctly rejecting it.
    expect(() => cli('--enemy-telegraph-ms', '250ms')).toThrow(/Invalid --enemy-telegraph-ms/);
  });

  it('throws when the flag is the final token with no value (regression: copilot-pull-request-reviewer finding)', () => {
    // The previous `arg === '--enemy-telegraph-ms' && next` guard silently
    // skipped this whole branch when `next` was undefined, letting the flag
    // fall through unconsumed and the run silently use the 250ms default
    // instead of failing on the malformed invocation.
    expect(() => cli('--enemy-telegraph-ms')).toThrow(/--enemy-telegraph-ms requires a value/);
  });

  it('throws on a whitespace-only value instead of silently disabling telegraphs (regression: copilot-pull-request-reviewer finding)', () => {
    // Number('   ') === 0, so a naive `next === ''` check let a whitespace-only
    // token slip past the missing-value guard and silently resolve to
    // enemyTelegraphMs: 0 (instant-fire, telegraph disabled) instead of
    // failing fast on the malformed invocation.
    expect(() => cli('--enemy-telegraph-ms', '   ')).toThrow(
      /--enemy-telegraph-ms requires a value/,
    );
  });
});
