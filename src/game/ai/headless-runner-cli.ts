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
  console.log(`Final Level:  ${stats.finalLevel}`);
  console.log(`Total XP:     ${stats.totalXp}`);
  console.log('');
  console.log(`Total Frames: ${stats.totalFrames}`);
  console.log(`Game Time:    ${(stats.gameTimeMs / 1000).toFixed(1)}s`);
  console.log(`Wall Time:    ${(stats.wallTimeMs / 1000).toFixed(1)}s`);
  console.log(`Avg FPS:      ${((stats.totalFrames / stats.wallTimeMs) * 1000).toFixed(0)}`);
  console.log('');
  console.log('⚔️  Combat Metrics');
  console.log(`  Kills:        ${stats.combat.totalKills}`);
  console.log(`  Engagements:  ${stats.combat.engagementCount}`);
  console.log(
    `  Combat Time:  ${(stats.combat.combatTimeMs / 1000).toFixed(1)}s (${((stats.combat.combatTimeMs / stats.gameTimeMs) * 100).toFixed(1)}%)`,
  );
  console.log(
    `  Damage Dealt: ${stats.combat.damageDealt.toFixed(0)} (${(stats.combat.damageDealt / (stats.gameTimeMs / 1000)).toFixed(1)}/s)`,
  );
  console.log(
    `  Damage Taken: ${stats.combat.damageTaken.toFixed(0)} (${(stats.combat.damageTaken / (stats.gameTimeMs / 1000)).toFixed(1)}/s)`,
  );
  console.log('');
  console.log('❤️  Health Metrics');
  console.log(`  Min HP:       ${(stats.health.minHealthPercent * 100).toFixed(1)}%`);
  console.log(`  Final HP:     ${(stats.health.finalHealthPercent * 100).toFixed(1)}%`);
  console.log(`  Close Calls:  ${stats.health.closeCallCount} (below 20%)`);
  console.log(`  Low Health:   ${stats.health.lowHealthCount} (below 50%)`);
  console.log('');
  console.log('📈 Level-Up Progression');
  if (stats.levelUps.length > 0) {
    stats.levelUps.forEach((levelUp, i) => {
      const timeSincePrev =
        i === 0 ? levelUp.gameTimeMs : levelUp.gameTimeMs - stats.levelUps[i - 1]!.gameTimeMs;
      console.log(
        `  Level ${levelUp.level}: ${(levelUp.gameTimeMs / 1000).toFixed(1)}s (+${(timeSincePrev / 1000).toFixed(1)}s)`,
      );
    });
  } else {
    console.log('  No level-ups');
  }
  console.log('');
  console.log('📜 Quest Metrics');
  console.log(`  Accepted:     ${stats.quests.questsAccepted}`);
  console.log(`  Completed:    ${stats.quests.questsCompleted}`);
  console.log(`  Failed:       ${stats.quests.questsFailed.length}`);
  if (stats.quests.mainQuestAcceptedMs !== null) {
    console.log(
      `  Main Quest:   Accepted at ${(stats.quests.mainQuestAcceptedMs / 1000).toFixed(1)}s`,
    );
    if (stats.quests.mainQuestCompletedMs !== null) {
      const duration = stats.quests.mainQuestCompletedMs - stats.quests.mainQuestAcceptedMs;
      console.log(
        `                Completed at ${(stats.quests.mainQuestCompletedMs / 1000).toFixed(1)}s (took ${(duration / 1000).toFixed(1)}s)`,
      );
    }
  }

  if (stats.error) {
    console.log('');
    console.log(`Error:        ${stats.error}`);
  }

  // Exit code: 0 for victory, 1 for death/timeout/error
  process.exit(stats.outcome === 'victory' ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
