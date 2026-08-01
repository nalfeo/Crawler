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

  it('keeps XP collection telemetry opt-in', () => {
    expect(cli().xpCollection).toBe(false);
    expect(cli('--xp-collection').xpCollection).toBe(true);
    expect(helpText()).toContain('--xp-collection');
  });

  it('throws on an invalid --decision-mode', () => {
    expect(() => cli('--decision-mode', 'bogus')).toThrow(/Invalid --decision-mode/);
  });

  it('throws on an invalid --pathing-mode', () => {
    expect(() => cli('--pathing-mode', 'bogus')).toThrow(/Invalid --pathing-mode/);
  });

  it('keeps merchant weapon purchase off by default and enables it by flag or environment', () => {
    expect(cli().merchantWeaponPurchase).toBe(false);
    expect(cli('--merchant-weapon-purchase').merchantWeaponPurchase).toBe(true);
    expect(
      parseArgs(['node', 'headless-runner-cli.js'], { AI_MERCHANT_WEAPON_PURCHASE: 'true' })
        .merchantWeaponPurchase,
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
