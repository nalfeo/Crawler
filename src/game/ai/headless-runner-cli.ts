#!/usr/bin/env node
/**
 * CLI for running headless AI simulations.
 *
 * Usage:
 *   node src/game/ai/headless-runner-cli.js --seed 12345 --max-frames 10000
 *
 * Or via npm:
 *   npm run ai:headless -- --seed 12345
 */
import { RuleBasedAI } from './ai-input-provider.js';
import { runHeadless } from './headless-runner.js';

interface CLIArgs {
  seed: number;
  maxFrames: number;
  maxTimeMs: number;
  progress: number;
  aggression: number;
  debug: boolean;
  help: boolean;
}

function parseArgs(): CLIArgs {
  const args: CLIArgs = {
    seed: 12345,
    maxFrames: 100_000,
    maxTimeMs: 5 * 60 * 1000,
    progress: 3600, // Report every minute of game time
    aggression: 1,
    debug: false,
    help: false,
  };

  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    const next = process.argv[i + 1];

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
      args.aggression = parseFloat(next);
      i++;
    } else if (arg === '--debug') {
      args.debug = true;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
Headless AI Runner CLI

Usage:
  node src/game/ai/headless-runner-cli.js [options]

Options:
  --seed <number>         Random seed (default: 12345)
  --max-frames <number>   Maximum frames to simulate (default: 100000)
  --max-time-ms <number>  Maximum wall-clock time in ms (default: 300000)
  --progress <number>     Report progress every N frames (default: 3600)
  --aggression <number>   AI aggression level 0-2 (default: 1)
  --debug                 Enable verbose logging
  --help, -h              Show this help message

Examples:
  # Quick test run
  node src/game/ai/headless-runner-cli.js --seed 42 --max-frames 10000

  # Long aggressive run with progress updates
  node src/game/ai/headless-runner-cli.js --seed 99 --aggression 2 --progress 1800
`);
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log('🤖 Starting headless AI run...');
  console.log(`Seed: ${args.seed}`);
  console.log(`Max frames: ${args.maxFrames}`);
  console.log(`Max time: ${args.maxTimeMs}ms`);
  console.log('');

  const ai = new RuleBasedAI({
    seed: args.seed,
    aggression: args.aggression,
    debug: args.debug,
  });

  const stats = await runHeadless(ai, {
    seed: args.seed,
    maxFrames: args.maxFrames,
    maxWallTimeMs: args.maxTimeMs,
    progressInterval: args.progress,
    debug: args.debug,
  });

  console.log('');
  console.log('📊 Run Complete');
  console.log('━'.repeat(50));
  console.log(`Outcome:      ${stats.outcome.toUpperCase()}`);
  console.log(`Final Floor:  ${stats.finalFloor}`);
  console.log(`Final Score:  ${stats.finalScore}`);
  console.log(`Total Frames: ${stats.totalFrames}`);
  console.log(`Game Time:    ${(stats.gameTimeMs / 1000).toFixed(1)}s`);
  console.log(`Wall Time:    ${(stats.wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`Avg FPS:      ${((stats.totalFrames / stats.wallTimeMs) * 1000).toFixed(0)}`);

  if (stats.error) {
    console.log(`Error:        ${stats.error}`);
  }

  // Exit code: 0 for victory, 1 for death/timeout/error
  process.exit(stats.outcome === 'victory' ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
