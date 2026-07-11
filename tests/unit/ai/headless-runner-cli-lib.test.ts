/**
 * Unit tests for the headless-runner CLI argument parser (A/B axis flags).
 *
 * Imports the side-effect-free `-lib` module (NOT the CLI entrypoint, which
 * runs a full simulation via `main()` on import). Covers the new
 * `--pathing-mode` / `--decision-mode` flags plus default behavior.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs, defaultCLIArgs } from '../../../src/game/ai/headless-runner-cli-lib.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

// parseArgs skips argv[0] (node) and argv[1] (script), matching process.argv.
function cli(...flags: string[]): ReturnType<typeof parseArgs> {
  return parseArgs(['node', 'headless-runner-cli.js', ...flags], {});
}

describe('headless-runner-cli parseArgs — A/B mode flags', () => {
  it('defaults both A/B axes to LEGACY', () => {
    const args = cli();
    expect(args.pathingMode).toBe(AIPathingMode.LEGACY);
    expect(args.decisionMode).toBe(AIDecisionMode.LEGACY);
    expect(args).toEqual(defaultCLIArgs({}));
  });

  it('parses a valid --decision-mode', () => {
    expect(cli('--decision-mode', 'slackAware').decisionMode).toBe(AIDecisionMode.SLACK_AWARE);
    expect(cli('--decision-mode', 'legacy').decisionMode).toBe(AIDecisionMode.LEGACY);
  });

  it('parses a valid --pathing-mode', () => {
    expect(cli('--pathing-mode', 'riskRewardFused').pathingMode).toBe(
      AIPathingMode.RISK_REWARD_FUSED,
    );
    expect(cli('--pathing-mode', 'navmesh').pathingMode).toBe(AIPathingMode.NAVMESH);
    expect(cli('--pathing-mode', 'navmeshFused').pathingMode).toBe(AIPathingMode.NAVMESH_FUSED);
    expect(cli('--pathing-mode', 'legacy').pathingMode).toBe(AIPathingMode.LEGACY);
  });

  it('parses both axes together alongside other flags', () => {
    const args = cli('--seed', '99', '--decision-mode', 'slackAware', '--pathing-mode', 'legacy');
    expect(args.seed).toBe(99);
    expect(args.decisionMode).toBe(AIDecisionMode.SLACK_AWARE);
    expect(args.pathingMode).toBe(AIPathingMode.LEGACY);
  });

  it('keeps weapon personas off by default and supports an explicit opt-in', () => {
    expect(cli().weaponPersonas).toBe(false);
    expect(cli('--weapon-personas').weaponPersonas).toBe(true);
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
});
