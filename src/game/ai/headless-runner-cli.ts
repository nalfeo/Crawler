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
import { writeFileSync } from 'node:fs';
import { BehaviorTreeAI } from './bt-ai-provider.js';
import { runHeadless } from './headless-runner.js';
import { getPersonaConfig, personaConfigDivergence } from './personas.js';
import { eventsToJsonl, summarizeEvents, type SimEvent } from './event-log.js';
import { helpText, parseArgs } from './headless-runner-cli-lib.js';

function printHelp(): void {
  console.log(helpText());
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
  if (args.weapon !== null) {
    console.log(`Weapon: ${args.weapon} (forced)`);
  }
  console.log(`Enemy damage mult: ${args.enemyDamageMultiplier}x`);
  console.log(`Enemy telegraph: ${args.enemyTelegraphMs}ms`);
  console.log(`Floor: ${args.floorId}`);
  if (args.startPlayerLevel > 1) {
    console.log(`Start player level: ${args.startPlayerLevel}`);
  }
  console.log(`Pathing mode:  ${args.pathingMode}`);
  console.log(`Decision mode: ${args.decisionMode}`);
  console.log(`Optional purchases: ${args.optionalPurchases ? 'enabled' : 'disabled'}`);
  console.log(`Persona: ${args.persona}`);
  console.log(
    `Settlement return routing: ${args.settlementReturnRouting ? 'enabled' : 'disabled'}`,
  );
  console.log('');

  // A persona label is only truthful while the run actually uses the preset.
  // `--aggression`/`--pathing-mode`/`--decision-mode` can override it, so a
  // diverging run stays UNLABELLED rather than contaminating that cohort's
  // cohort scores with behavior the persona never had.
  const personaDivergence = personaConfigDivergence(args.persona, {
    ...(args.aggression !== null ? { aggression: args.aggression } : {}),
    pathingMode: args.pathingMode,
    decisionMode: args.decisionMode,
  });
  if (personaDivergence.length > 0) {
    console.log(
      `⚠️  Persona "${args.persona}" overridden by: ${personaDivergence.join(', ')} — run will NOT be labelled with this persona.`,
    );
  }

  const ai = new BehaviorTreeAI({
    ...getPersonaConfig(args.persona),
    seed: args.seed,
    ...(args.aggression !== null ? { aggression: args.aggression } : {}),
    debug: args.debug,
    pathingMode: args.pathingMode,
    decisionMode: args.decisionMode,
  });

  const recording = args.eventLog !== null || args.eventSummary !== null;
  const events: SimEvent[] = [];

  const stats = await runHeadless(ai, {
    seed: args.seed,
    maxFrames: args.maxFrames,
    maxWallTimeMs: args.maxTimeMs,
    progressInterval: args.progress,
    debug: args.debug,
    eventSampleInterval: args.sampleInterval,
    ...(args.weapon !== null ? { forceWeaponId: args.weapon } : {}),
    enemyDamageMultiplier: args.enemyDamageMultiplier,
    enemyTelegraphMs: args.enemyTelegraphMs,
    floorId: args.floorId,
    startPlayerLevel: args.startPlayerLevel,
    recordWeaponTelemetry: args.weaponTelemetry,
    weaponPersonas: args.weaponPersonas,
    optionalPurchases: args.optionalPurchases,
    ...(personaDivergence.length === 0 ? { playerPersona: args.persona } : {}),
    settlementReturnRouting: args.settlementReturnRouting,
    ...(recording
      ? {
          recordEvent: (event: SimEvent): void => {
            events.push(event);
          },
        }
      : {}),
  });

  console.log('');
  console.log('📊 Run Complete');
  console.log('━'.repeat(50));
  console.log(`Outcome:      ${stats.outcome.toUpperCase()}`);
  if (stats.stallReason) {
    console.log(`Stall:        ${stats.stallReason}`);
  }
  console.log(`Starting Wep: ${stats.startingWeapon}`);
  console.log(`Final Floor:  ${stats.finalFloor}`);
  console.log(`Final Score:  ${stats.finalScore}`);
  console.log(`Final Level:  ${stats.finalLevel}`);
  console.log(`Total XP:     ${stats.totalXp}`);
  console.log(`Total Gold:   ${stats.totalGold}`);
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
  const damageSources = Object.entries(stats.combat.damageTakenBySource).sort(
    ([aName, aDamage], [bName, bDamage]) => bDamage - aDamage || aName.localeCompare(bName),
  );
  if (damageSources.length > 0) {
    console.log('  Damage Sources:');
    for (const [source, damage] of damageSources) {
      console.log(`    ${source}: ${damage.toFixed(1)}`);
    }
  }
  if (stats.weaponTelemetry) {
    const wt = stats.weaponTelemetry;
    console.log('');
    console.log('🎯 Weapon Accuracy');
    console.log(`  Swings:       ${wt.swings}`);
    console.log(
      `  Connecting:   ${wt.connectingSwings} (${(wt.accuracy * 100).toFixed(1)}% accuracy)`,
    );
    console.log(`  Acc. Misses:  ${wt.accuracyMisses}`);
    console.log(
      `  Multi-hit:    ${wt.multiHitSwings} (${(wt.multiHitRate * 100).toFixed(1)}% of connecting)`,
    );
    console.log(
      `  Enemies Hit:  ${wt.totalEnemyHits} (${wt.avgEnemiesPerConnectingSwing.toFixed(2)}/connecting swing)`,
    );
  }
  if (stats.goldEconomy) {
    const ge = stats.goldEconomy;
    console.log('');
    console.log('💰 Gold Economy');
    console.log(
      `  Earned:       ${ge.earnedTotal} (drops ${ge.earnedFromDrops}, loot boxes ${ge.earnedFromLootBoxes})`,
    );
    console.log(
      `  Spent:        ${ge.spentTotal} (charm ${ge.spentOnCharm}, weapon ${ge.spentOnMerchantWeapon}, spell ${ge.spentOnSpell})`,
    );
    console.log(
      `  Unspent:      ${ge.unspentAtExit} (${(ge.unspentFraction * 100).toFixed(1)}% of earned)`,
    );
    console.log(
      `  Spendable:    ${ge.spendableEarned} earned before exit — unspent ${ge.unspentSpendable} (${(ge.unspentSpendableFraction * 100).toFixed(1)}%)`,
    );
    console.log(
      `  Purchases:    ${ge.distinctPurchases} vendors (charm ${ge.charmPurchases}, weapon ${ge.merchantWeaponPurchases}, spell ${ge.spellPurchases})`,
    );
  }
  if (stats.vendors) {
    const vendors = stats.vendors;
    console.log('');
    console.log('🛒 Vendor Visits & Decisions');
    console.log(
      `  Visits:       ${vendors.visitCount} (${
        Object.entries(vendors.visitsByVendor)
          .map(([vendorId, count]) => `${vendorId} ${count}`)
          .join(', ') || 'none'
      })`,
    );
    for (const visit of vendors.visits) {
      const stock =
        visit.stock.map((entry) => `${entry.itemId} ${entry.cost}g`).join(', ') || 'empty';
      console.log(
        `    ${(visit.gameTimeMs / 1000).toFixed(1)}s ${visit.vendorId} — gold ${visit.playerGold}, stock: ${stock}`,
      );
    }
    console.log(
      `  Decisions:    ${vendors.decisionCount} (${Object.entries(vendors.outcomeCounts)
        .map(([outcome, count]) => `${outcome} ${count}`)
        .join(', ')})`,
    );
    for (const decision of vendors.decisions) {
      console.log(
        `    ${(decision.gameTimeMs / 1000).toFixed(1)}s ${decision.vendorId} — ${decision.outcome} ${
          decision.itemId ?? 'nothing'
        } (${decision.cost}g, gold ${decision.playerGold}, ${decision.reason})`,
      );
    }
  }
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

  // Canonical quest-log view (floor-agnostic — reads world.questLog).
  const accepts = stats.quests.questLogAccepts;
  const completions = stats.quests.questLogCompletions;
  const questIds = Object.keys(accepts);
  if (questIds.length > 0) {
    console.log('');
    console.log('📖 Quest Log (canonical)');
    if (stats.quests.firstQuestCompletedMs !== null) {
      console.log(
        `  First quest completed at ${(stats.quests.firstQuestCompletedMs / 1000).toFixed(1)}s`,
      );
    }
    for (const id of questIds) {
      const acceptedAt = accepts[id];
      const completedAt = completions[id];
      const acceptStr = acceptedAt !== undefined ? `${(acceptedAt / 1000).toFixed(1)}s` : '—';
      const completeStr =
        completedAt !== undefined ? `✓ ${(completedAt / 1000).toFixed(1)}s` : 'incomplete';
      console.log(`    ${id}: accepted ${acceptStr}, ${completeStr}`);
    }
  }

  if (stats.floor2Progression) {
    console.log('');
    console.log('🏰 Floor 2 Progression');
    for (const [familyId, family] of Object.entries(stats.floor2Progression.families)) {
      const unlockKills =
        family.trashKillsAtDenUnlock === null ? 'n/a' : String(family.trashKillsAtDenUnlock);
      console.log(
        `  ${familyId.padEnd(10)} kills ${String(family.trashKills).padStart(3)} ` +
          `(unlock ${unlockKills.padStart(3)}) · den ${family.denEntered ? 'entered' : 'not entered'} · ` +
          `boss ${family.encounterStarted ? `started ${(family.encounterStartedMs! / 1000).toFixed(1)}s lv${family.levelAtEncounterStart ?? '?'}` : 'not started'}/` +
          `${family.encounterDefeated ? `defeated ${(family.encounterDefeatedMs! / 1000).toFixed(1)}s` : 'alive'}`,
      );
    }
    console.log(
      `  Exit:       ${stats.floor2Progression.exitCompleted ? 'completed' : 'incomplete'}`,
    );
    const hunt = stats.floor2Progression.hunt;
    const huntKills = hunt.huntFamilyTrashKills + hunt.huntNeutralTrashKills;
    const familyKillRatio = huntKills > 0 ? hunt.huntFamilyTrashKills / huntKills : 0;
    console.log(
      `  Hunt:       ${(hunt.huntTimeMs / 1000).toFixed(1)}s · COMBAT ${(hunt.activeCombatRatio * 100).toFixed(1)}% ` +
        `(ENGAGE ${(hunt.engageRatio * 100).toFixed(1)}%) · ` +
        `kills ${hunt.huntFamilyTrashKills} family/${hunt.huntNeutralTrashKills} neutral ` +
        `(${(familyKillRatio * 100).toFixed(1)}% family) · ` +
        `nearby ${hunt.averageNearbyEnemies.toFixed(1)} avg/${hunt.peakNearbyEnemies} peak`,
    );
  }

  if (stats.error) {
    console.log('');
    console.log(`Error:        ${stats.error}`);
  }

  // Telemetry / event-log output
  if (recording) {
    const summary = summarizeEvents(events);
    console.log('');
    console.log('🔍 Wasted-Time Analysis');
    console.log(`  Samples:       ${events.filter((e) => e.type === 'sample').length}`);
    console.log(
      `  Wiggle Time:   ${(summary.wiggleMs / 1000).toFixed(1)}s (${summary.wigglePct.toFixed(1)}%)`,
    );
    console.log(
      `  Idle Time:     ${(summary.idleMs / 1000).toFixed(1)}s (${summary.idlePct.toFixed(1)}%)`,
    );
    console.log(
      `  Stuck Time:    ${(summary.stuckMs / 1000).toFixed(1)}s (${summary.stuckPct.toFixed(1)}%)`,
    );
    console.log(`  Travel Eff.:   ${(summary.travelEfficiency * 100).toFixed(1)}%`);
    console.log(
      `  Time→1st Kill: ${summary.timeToFirstKillMs === null ? 'n/a' : `${(summary.timeToFirstKillMs / 1000).toFixed(1)}s`}`,
    );
    console.log(
      `  Longest Gap:   ${summary.longestKillGapMs === null ? 'n/a' : `${(summary.longestKillGapMs / 1000).toFixed(1)}s`} between kills`,
    );
    console.log('  State breakdown:');
    for (const [state, ms] of Object.entries(summary.stateMs)) {
      const pct = summary.durationMs > 0 ? (ms / summary.durationMs) * 100 : 0;
      console.log(`    ${state.padEnd(10)} ${(ms / 1000).toFixed(1)}s (${pct.toFixed(1)}%)`);
    }
    if (summary.wiggleEpisodes.length > 0) {
      console.log(`  Top wiggle episodes (${summary.wiggleEpisodes.length}):`);
      for (const ep of summary.wiggleEpisodes.slice(0, 5)) {
        console.log(
          `    @${(ep.startMs / 1000).toFixed(1)}s for ${(ep.durationMs / 1000).toFixed(1)}s` +
            ` [${ep.state}] near (${ep.px},${ep.py})`,
        );
      }
    }

    if (args.eventLog !== null) {
      writeFileSync(args.eventLog, eventsToJsonl(events), 'utf8');
      console.log('');
      console.log(`📝 Event log written: ${args.eventLog} (${events.length} events)`);
    }
    if (args.eventSummary !== null) {
      writeFileSync(args.eventSummary, JSON.stringify(summary, null, 2), 'utf8');
      console.log(`📝 Summary written:   ${args.eventSummary}`);
    }
  }

  // Exit code: 0 for victory, 1 for death/timeout/error
  process.exit(stats.outcome === 'victory' ? 0 : 1);
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
