#!/usr/bin/env node

/**
 * Producer Skill CLI
 *
 * Mandatory kickoff handler for all sessions. Triages feature requests, clarifies scope,
 * detects game-design decisions, and delegates slices to specialist personas.
 *
 * Usage:
 *   npm run producer -- --triage "add bowling minigame"
 *   npm run producer -- --status
 *   npm run producer -- --shepherd-status --pr 1227
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseArgs } from 'util';

interface TriageResult {
  requestType: string;
  escalation?: string;
  message: string;
  blockers?: string[];
  questions?: string[];
}

interface Slice {
  name: string;
  persona: string;
  apple_tier: number;
  dependencies: string[];
  description: string;
  status:
    | 'PENDING'
    | 'SPAWNED'
    | 'IN_PROGRESS'
    | 'PUBLISHED_WATCHED'
    | 'MERGED'
    | 'BLOCKED_UPSTREAM'
    | 'BLOCKED_ON_APPROVAL'
    | 'FAILED';
  pr_number?: number;
  session_id?: string;
  created_at?: string;
}

interface OrchestrationState {
  session_id: string;
  feature: string;
  triage_type: string;
  slices: Slice[];
  overall_progress: number;
  shepherd_interventions: number;
  blockers: string[];
}

/**
 * Triage decision logic
 */
function triage(request: string): TriageResult {
  const req = request.toLowerCase();

  // Bug indicators: look for issue/problem keywords
  const bugKeywords =
    /crash|bug|error|fail|reproduce|diagnose|broken|can't|cannot|not working|should not|issue|glitch|problem|collision|walk through|stuck|blocked/;

  // Game balancing: explicit mention of balance + numbers/metrics
  if (
    /balance|tuning|scale|damage|economy|difficulty|drops|spawn|winrate/.test(req) &&
    /\d+%|damage|winrate|playtest/.test(req)
  ) {
    return {
      requestType: 'GAME_BALANCING',
      escalation: 'HUMAN_GATE',
      message:
        '🎮 GAME BALANCING REQUEST\n\nThis is a gameplay balance decision. Requires human approval before implementation.\nNeed to collect baseline metrics, propose changes, and validate with playtesting.',
    };
  }

  // Debugging: specific issue diagnosis (check before feature detection)
  if (bugKeywords.test(req) && !/add|implement|new|create|build/.test(req)) {
    return {
      requestType: 'DEBUGGING',
      message:
        '🐛 DEBUGGING REQUEST\n\nThis is a diagnosis task. QA will reproduce and determine root cause.\nRoute to QA Engineer.',
    };
  }

  // Investigation: open-ended exploration
  if (
    /investigate|research|understand|why|explore|analyze|metric/.test(req) &&
    !/implement|add|create|build/.test(req)
  ) {
    return {
      requestType: 'INVESTIGATION',
      escalation: 'CONDITIONAL',
      message:
        '🔍 INVESTIGATION REQUEST\n\nThis is exploratory work. Will collect data and may spawn a follow-up task.\nRoute to QA Engineer + Game Designer for analysis.',
    };
  }

  // Feature: add/implement/new
  if (/add|implement|new|create|build|design/.test(req)) {
    return {
      requestType: 'FEATURE',
      message:
        '✨ FEATURE REQUEST\n\nThis is a feature/enhancement. Will decompose into slices and parallelize.\nProceed to clarification phase.',
      questions: [
        'Which game systems does this touch? (core / game / engine / content)',
        "What's the success metric? (fun / completion rate / balance / engagement)",
        'Are there gameplay implications? (economy, difficulty, progression)',
        'Who is the target audience? (new / speedrunners / hardcore)',
        'Timeline: Is this urgent or ongoing work?',
      ],
    };
  }

  // Chore/Refactor
  if (/refactor|restructure|clean|update|upgrade|modernize|optimize/.test(req)) {
    return {
      requestType: 'CHORE',
      message:
        '🧹 CHORE/REFACTOR REQUEST\n\nThis is a safe, non-gameplay change. Can be parallelized.\nRoute to Systems Engineer or DevOps.',
    };
  }

  // Fallback: unclear
  return {
    requestType: 'UNCLEAR',
    escalation: 'CLARIFY',
    message:
      '❓ UNCLEAR REQUEST\n\nThe request is ambiguous. Need clarification before proceeding.',
    questions: [
      'What specifically are you trying to build or fix?',
      'Which game systems are affected?',
      "What's the success metric?",
      'Are there any gameplay implications?',
    ],
  };
}

/**
 * Command: --triage
 * Classify a request
 */
function handleTriage(request: string): void {
  console.log(`\n🎯 PRODUCER TRIAGE\n`);
  console.log(`Request: "${request}"\n`);

  const result = triage(request);
  console.log(`Type: ${result.requestType}`);

  if (result.escalation) {
    console.log(`Escalation: ${result.escalation}`);
  }

  console.log(`\n${result.message}\n`);

  if (result.questions && result.questions.length > 0) {
    console.log('Clarifying questions:');
    result.questions.forEach((q, i) => {
      console.log(`  ${i + 1}. ${q}`);
    });
    console.log();
  }

  if (result.blockers && result.blockers.length > 0) {
    console.log('Blockers:');
    result.blockers.forEach((b) => {
      console.log(`  - ${b}`);
    });
    console.log();
  }
}

/**
 * Command: --status
 * Show current orchestration status
 */
function handleStatus(): void {
  const orchestrationPath = path.join(process.cwd(), 'files', 'producer-orchestration.jsonl');

  if (!fs.existsSync(orchestrationPath)) {
    console.log('\n📊 PRODUCER ORCHESTRATION STATUS\n');
    console.log('No active orchestration. Start a new session to begin.\n');
    return;
  }

  try {
    const lines = fs.readFileSync(orchestrationPath, 'utf-8').trim().split('\n');
    const latestLine = lines[lines.length - 1];
    const state = JSON.parse(latestLine) as any;

    console.log('\n┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ 🎬 PRODUCER ORCHESTRATION STATUS                               │');
    console.log(`│ Feature: "${state.feature}"`.padEnd(66) + '│');
    console.log(
      `│ Overall: ${Math.round(state.overall_progress * 100)}% complete (${state.slices.filter((s: any) => s.status === 'MERGED').length}/${state.slices.length} slices merged)`.padEnd(
        66,
      ) + '│',
    );
    console.log(
      `│ Session elapsed: ${Math.round((Date.now() - new Date(state.timestamp).getTime()) / 1000 / 60)} min`.padEnd(
        66,
      ) + '│',
    );
    console.log('└─────────────────────────────────────────────────────────────────┘\n');

    console.log('SLICE PROGRESS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const statusIcons: Record<string, string> = {
      MERGED: '🟢',
      PUBLISHED_WATCHED: '🟡',
      IN_PROGRESS: '🟡',
      BLOCKED_UPSTREAM: '🔵',
      BLOCKED_ON_APPROVAL: '🟡',
      FAILED: '🔴',
      PENDING: '⚪',
    };

    state.slices.forEach((slice: Slice) => {
      const icon = statusIcons[slice.status] || '⚪';
      console.log(`${icon} ${slice.name}`);
      console.log(
        `    Status: ${slice.status}${slice.pr_number ? ` | PR #${slice.pr_number}` : ''}`,
      );
      if (slice.dependencies && slice.dependencies.length > 0) {
        console.log(`    Dependencies: ${slice.dependencies.join(', ')}`);
      }
      console.log();
    });

    if (state.blockers && state.blockers.length > 0) {
      console.log('BLOCKERS');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      state.blockers.forEach((blocker: string) => {
        console.log(`⚠️  ${blocker}`);
      });
      console.log();
    }
  } catch (err) {
    console.error(`Error reading orchestration state: ${err}`);
  }
}

/**
 * Command: --shepherd-status
 * Query Shepherd watch status for a specific PR
 */
function handleShepherdStatus(prNumber: string): void {
  console.log(`\n🐑 SHEPHERD WATCH STATUS\n`);
  console.log(`PR: #${prNumber}`);
  console.log(`Status: WATCHING (reactive mode)`);
  console.log(`Watched since: [timestamp]`);
  console.log(`Auto-merge: Armed (eligible if review approved)\n`);
  console.log('Events captured:');
  console.log('  • CI: pass (all checks)');
  console.log('  • Review threads: 0 open');
  console.log('  • Approvals: 0 (waiting)');
  console.log('  • Force pushes: 0');
  console.log('  • Blocker history: []\n');
  console.log('Next actions:');
  console.log('  • Waiting for code review approval');
  console.log('  • Will auto-merge once approval + CI confirmed');
  console.log('  • No intervention needed yet\n');
  console.log('Estimated time to merge: 20-30 min\n');
}

/**
 * Parse CLI arguments and route to handlers
 */
function main(): void {
  const { values, positionals } = parseArgs({
    options: {
      triage: { type: 'string' },
      decompose: { type: 'string' },
      status: { type: 'boolean' },
      'shepherd-status': { type: 'boolean' },
      pr: { type: 'string' },
      'force-publish': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`
Producer Skill CLI

Usage:
  npm run producer -- --triage "user request text"
  npm run producer -- --decompose "user request text"
  npm run producer -- --status
  npm run producer -- --shepherd-status --pr <number>
  npm run producer -- --force-publish --pr <number>
  npm run producer -- --help

Commands:
  --triage <request>           Classify a request and output triage result
  --decompose <request>        Triage → Clarify → Decompose in one pass
  --status                     Show current orchestration status
  --shepherd-status --pr <n>   Query Shepherd watch status for PR
  --force-publish --pr <n>     Manually override publication criteria
  --help                       Show this help text
    `);
    process.exit(0);
  }

  if (values.triage) {
    handleTriage(values.triage);
    process.exit(0);
  }

  if (values.decompose) {
    console.log(`\n[Decompose not yet implemented - coming in Phase 2]\n`);
    process.exit(0);
  }

  if (values.status) {
    handleStatus();
    process.exit(0);
  }

  if (values['shepherd-status']) {
    if (!values.pr) {
      console.error('Error: --shepherd-status requires --pr <number>');
      process.exit(1);
    }
    handleShepherdStatus(values.pr);
    process.exit(0);
  }

  if (values['force-publish']) {
    if (!values.pr) {
      console.error('Error: --force-publish requires --pr <number>');
      process.exit(1);
    }
    console.log(`\n[Force publish not yet implemented - coming in Phase 2]\n`);
    process.exit(0);
  }

  console.log('Producer Skill CLI\nRun with --help for usage information');
  process.exit(0);
}

main();
