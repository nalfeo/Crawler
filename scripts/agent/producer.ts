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
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'util';
import { fileURLToPath } from 'url';
import { basename } from 'path';

import { loadPersonaRouting, systemsByPersona } from './shared/persona-routing.js';

interface TriageResult {
  requestType: string;
  verdict: 'RECOMMENDED' | 'RISKY' | 'NOT_RECOMMENDED';
  verdictReason: string;
  escalation?: string;
  confidence?: number;
  nextAction?: string;
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
    | 'PUBLISHED_DETACHED'
    | 'MERGED'
    | 'BLOCKED_UPSTREAM'
    | 'BLOCKED_ON_APPROVAL'
    | 'FAILED';
  pr_number?: number;
  session_id?: string;
  created_at?: string;
}

interface OrchestrationState {
  schema: 'producer-orchestration-state/v1';
  timestamp: string;
  session_id: string;
  feature: string;
  triage_type: string;
  slices: Slice[];
  overall_progress: number;
  cloud_recovery_handoffs: number;
  blockers: string[];
  contract_status?: PlanningContract['gateStatus'];
  hard_gate?: string;
}

interface ProducerEvent {
  schema: 'producer-orchestration-event/v1';
  timestamp: string;
  session_id: string;
  event:
    | 'decompose_completed'
    | 'force_publish_requested'
    | 'pr_published'
    | 'auto_merge_armed'
    | 'session_released'
    | 'force_publish_failed';
  feature?: string;
  pr_number?: number;
  details?: Record<string, string | number | boolean>;
}

const ORCHESTRATION_FILE = path.join(process.cwd(), 'files', 'producer-orchestration.jsonl');

function ensureParentDirectory(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonlLine(filePath: string, payload: OrchestrationState | ProducerEvent): void {
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf-8');
}

function isSlice(value: unknown): value is Slice {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<Slice>;
  return (
    typeof candidate.name === 'string' &&
    typeof candidate.persona === 'string' &&
    typeof candidate.apple_tier === 'number' &&
    Array.isArray(candidate.dependencies) &&
    typeof candidate.description === 'string' &&
    typeof candidate.status === 'string'
  );
}

function isOrchestrationState(value: unknown): value is OrchestrationState {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<OrchestrationState>;
  return (
    candidate.schema === 'producer-orchestration-state/v1' &&
    typeof candidate.timestamp === 'string' &&
    typeof candidate.session_id === 'string' &&
    typeof candidate.feature === 'string' &&
    typeof candidate.triage_type === 'string' &&
    Array.isArray(candidate.slices) &&
    candidate.slices.every((slice) => isSlice(slice)) &&
    typeof candidate.overall_progress === 'number' &&
    typeof candidate.cloud_recovery_handoffs === 'number' &&
    Array.isArray(candidate.blockers)
  );
}

function getSessionId(): string {
  return process.env.COPILOT_SESSION_ID || process.env.GITHUB_RUN_ID || 'local-session';
}

/**
 * Triage decision logic
 */
export function triage(request: string): TriageResult {
  const req = request.toLowerCase();

  // Bug indicators: look for issue/problem keywords
  const bugKeywords =
    /crash|bug|error|fail|reproduce|diagnose|broken|can't|cannot|not working|should not|issue|glitch|problem|collision|walk through|stuck|blocked/;
  const balanceKeywords =
    /\b(?:balance|tuning|damage|health|economy|difficulty|drops?|spawn(?:\s+pressure|\s+rate)?|winrate|progression|xp|gold|currency|reward|cost|price)\b/;
  const balanceChangeSignals =
    /\d+%|playtest|\b(?:increase|decrease|reduce|boost|buff|nerf|harder|easier|more|less|faster|slower|higher|lower|change|adjust|rebalance|tune|set|deal|grant|raise|lower)\b|\b\d+\s*(?:damage|health|gold|xp|experience|currency|rewards?|seconds?|spawns?)\b/;
  const cosmeticBalanceContexts =
    /\b(?:ui|hud|menu|screen|overlay|popup|popups|log|report|filter|style|styles|visual|vfx|particle|audio|sound)\b/;

  // Game balancing: explicit gameplay-parameter changes require a human gate.
  if (
    balanceKeywords.test(req) &&
    balanceChangeSignals.test(req) &&
    !cosmeticBalanceContexts.test(req)
  ) {
    return {
      requestType: 'GAME_BALANCING',
      verdict: 'RISKY',
      verdictReason: 'Gameplay balance changes need human approval and baseline metrics first.',
      escalation: 'HUMAN_GATE',
      confidence: 0.95,
      nextAction: 'Collect baseline metrics and ask for approval.',
      message:
        '🎮 GAME BALANCING REQUEST\n\nThis is a gameplay balance decision. Requires human approval before implementation.\nNeed to collect baseline metrics, propose changes, and validate with playtesting.',
    };
  }

  // Debugging: specific issue diagnosis (check before feature detection)
  if (bugKeywords.test(req) && !/add|implement|new|create|build/.test(req)) {
    return {
      requestType: 'DEBUGGING',
      verdict: 'RECOMMENDED',
      verdictReason: 'Fixing a concrete bug is usually a good idea and low ambiguity.',
      confidence: 0.9,
      nextAction: 'Route to QA for reproduction and a real runtime artifact.',
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
      verdict: 'RECOMMENDED',
      verdictReason: 'Investigation is a safe way to reduce uncertainty before changing behavior.',
      escalation: 'CONDITIONAL',
      confidence: 0.85,
      nextAction: 'Define the metric and evidence source before analysis.',
      message:
        '🔍 INVESTIGATION REQUEST\n\nThis is exploratory work. Will collect data and may spawn a follow-up task.\nRoute to QA Engineer + Game Designer for analysis.',
    };
  }

  // Feature: add/implement/new
  if (/add|implement|new|create|build|design/.test(req)) {
    return {
      requestType: 'FEATURE',
      verdict: 'RECOMMENDED',
      verdictReason:
        'A feature request is reasonable to plan, but it still needs scope clarification first.',
      confidence: 0.65,
      nextAction: 'Ask for one measurable hard gate, then decompose.',
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
      verdict: 'RECOMMENDED',
      verdictReason: 'Non-gameplay cleanup is usually safe and suitable for direct execution.',
      confidence: 0.85,
      nextAction: 'Route to the owning engineering or DevOps persona.',
      message:
        '🧹 CHORE/REFACTOR REQUEST\n\nThis is a safe, non-gameplay change. Can be parallelized.\nRoute to Systems Engineer or DevOps.',
    };
  }

  // Fallback: unclear
  return {
    requestType: 'UNCLEAR',
    verdict: 'NOT_RECOMMENDED',
    verdictReason: 'The request is too ambiguous to execute safely without clarification.',
    escalation: 'CLARIFY',
    confidence: 0.1,
    nextAction: 'Ask the highest-value framing question before routing.',
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
export function renderTriage(request: string): string {
  const result = triage(request);
  const lines = [``, '🎯 PRODUCER TRIAGE', '', `Request: "${request}"`, ''];
  lines.push(`Type: ${result.requestType}`);
  lines.push(`Verdict: ${result.verdict} — ${result.verdictReason}`);
  if (result.confidence !== undefined) {
    lines.push(`Planning confidence: ${Math.round(result.confidence * 100)}%`);
  }
  if (result.nextAction) lines.push(`Next action: ${result.nextAction}`);

  if (result.escalation) {
    lines.push(`Escalation: ${result.escalation}`);
  }

  lines.push('', result.message, '');

  if (result.questions && result.questions.length > 0) {
    lines.push('Clarifying questions:');
    result.questions.forEach((q, i) => {
      lines.push(`  ${i + 1}. ${q}`);
    });
    lines.push('');
  }

  if (result.blockers && result.blockers.length > 0) {
    lines.push('Blockers:');
    result.blockers.forEach((b) => {
      lines.push(`  - ${b}`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function handleTriage(request: string): void {
  console.log(renderTriage(request));
}

/**
 * Command: --status
 * Show current orchestration status
 */
function handleStatus(): void {
  if (!fs.existsSync(ORCHESTRATION_FILE)) {
    console.log('\n📊 PRODUCER ORCHESTRATION STATUS\n');
    console.log('No active orchestration. Start a new session to begin.\n');
    return;
  }

  try {
    const fileContent = fs.readFileSync(ORCHESTRATION_FILE, 'utf-8').trim();
    if (!fileContent) {
      console.log('\n📊 PRODUCER ORCHESTRATION STATUS\n');
      console.log('No orchestration state recorded yet.\n');
      return;
    }

    const lines = fileContent.split('\n');
    const latestStateLine = [...lines]
      .reverse()
      .find((line) => line.includes('"schema":"producer-orchestration-state/v1"'));
    if (!latestStateLine) {
      console.log('\n📊 PRODUCER ORCHESTRATION STATUS\n');
      console.log('No orchestration state snapshots found yet.\n');
      return;
    }
    const parsedState = JSON.parse(latestStateLine) as unknown;
    if (!isOrchestrationState(parsedState)) {
      console.log('\n📊 PRODUCER ORCHESTRATION STATUS\n');
      console.log('Invalid orchestration state. Try again.\n');
      return;
    }
    const state = parsedState;
    const mergedCount = state.slices.filter((slice) => slice.status === 'MERGED').length;

    console.log('\n┌─────────────────────────────────────────────────────────────────┐');
    console.log('│ 🎬 PRODUCER ORCHESTRATION STATUS                               │');
    console.log(`│ Feature: "${state.feature}"`.padEnd(66) + '│');
    console.log(
      `│ Overall: ${Math.round(state.overall_progress * 100)}% complete (${mergedCount}/${state.slices.length} slices merged)`.padEnd(
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
      PUBLISHED_DETACHED: '🟡',
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
  try {
    const viewRaw = execFileSync(
      'gh',
      [
        'pr',
        'view',
        String(prNumber),
        '--json',
        'isDraft,mergeStateStatus,reviewDecision,statusCheckRollup,url,title',
      ],
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(viewRaw) as {
      isDraft?: boolean;
      mergeStateStatus?: string;
      reviewDecision?: string;
      statusCheckRollup?: Array<{ conclusion?: string }>;
      url?: string;
      title?: string;
    };
    const checks = parsed.statusCheckRollup ?? [];
    const failingConclusions = new Set([
      'FAILURE',
      'TIMED_OUT',
      'CANCELLED',
      'ACTION_REQUIRED',
      'STARTUP_FAILURE',
    ]);
    const failingChecks = checks.filter(
      (check) => check.conclusion && failingConclusions.has(check.conclusion),
    ).length;
    const passingChecks = checks.filter((check) => check.conclusion === 'SUCCESS').length;

    console.log(`\n🐑 SHEPHERD WATCH STATUS\n`);
    console.log(`PR: #${prNumber} ${parsed.title ? `- ${parsed.title}` : ''}`);
    if (parsed.url) console.log(parsed.url);
    console.log(`Draft: ${parsed.isDraft ? 'yes' : 'no'}`);
    console.log(`Merge state: ${parsed.mergeStateStatus ?? 'UNKNOWN'}`);
    console.log(`Review decision: ${parsed.reviewDecision ?? 'PENDING'}`);
    console.log(`Checks: ${passingChecks} passing, ${failingChecks} failing`);
    console.log('\nProducer handoff policy: Shepherd should run in reactive watch mode.');
  } catch (err) {
    console.error(`Unable to query live PR status for #${prNumber}: ${err}`);
    process.exit(1);
  }
}

/**
 * Slice definition: a decomposed piece of work mapped to a persona
 */
interface SliceDecomposition {
  id: string;
  name: string;
  persona: string;
  systems: string[];
  apples: number;
  description: string;
  dependencies: string[];
}

/**
 * Decomposition result: feature broken into parallelizable slices
 */
interface DecompositionResult {
  feature: string;
  slices: SliceDecomposition[];
  totalApples: number;
  criticalPath: string[];
  parallelizableGroups: string[][];
  escalations: string[];
  contract: PlanningContract;
}

export interface PlanningContract {
  hardGate: string | null;
  gateStatus: 'READY' | 'MISSING';
  rankedTiebreakers: string[];
  confidence: number;
  readyForDelegation: boolean;
  validationErrors: string[];
}

const SUCCESS_GATE_PATTERN =
  /(?:\b(?:success|target|at least|minimum|within|reach|achieve|maintain)\b.{0,50}\b\d+(?:\.\d+)?\s*(?:%|ms|s|seconds?|minutes?|runs?|tests?)\b|\b\d+(?:\.\d+)?\s*%\s*(?:win\s*rate|coverage)\b|\ball\s+tests?\s+(?:pass|passing|passed)\b|\b(?:reach|achieve|maintain|ensure|verify)\s+zero\s+(?:regressions?|failures?)\b|\b(?:fps|latency)\s*(?:>=|<=|at least|below|under)\s*\d+)/i;

function inferPlanningContract(request: string, slices: SliceDecomposition[]): PlanningContract {
  const hasGate = SUCCESS_GATE_PATTERN.test(request);
  const hardGate = hasGate
    ? `Verify the request's stated measurable condition: "${request}".`
    : null;

  return {
    hardGate,
    gateStatus: hardGate ? 'READY' : 'MISSING',
    rankedTiebreakers: [
      'Preserve deterministic runtime behavior and existing gameplay contracts.',
      'Keep each slice independently verifiable at its layer boundary.',
      'Prefer parallel work only when dependencies are explicit and acyclic.',
    ],
    confidence: Math.max(0, Math.min(1, (hasGate ? 0.8 : 0.55) + (slices.length > 0 ? 0.1 : 0))),
    readyForDelegation: Boolean(hardGate),
    validationErrors: [],
  };
}

export function validateDecomposition(result: DecompositionResult): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const visiting = new Set<string>();
  const visited = new Set<string>();

  for (const slice of result.slices) {
    if (ids.has(slice.id)) {
      errors.push(`Duplicate slice id: ${slice.id}`);
    }
    ids.add(slice.id);
    if (slice.apples < 1 || slice.apples > 3) {
      errors.push(`${slice.id} exceeds the 1–3🍎 slice limit.`);
    }
    for (const dependency of slice.dependencies) {
      if (dependency === slice.id) {
        errors.push(`${slice.id} depends on itself.`);
      }
    }
  }

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle detected at ${id}.`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    const slice = result.slices.find((candidate) => candidate.id === id);
    for (const dependency of slice?.dependencies ?? []) {
      if (!ids.has(dependency)) errors.push(`${id} depends on unknown slice ${dependency}.`);
      else visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  };

  result.slices.forEach((slice) => visit(slice.id));
  return [...new Set(errors)];
}

/**
 * Decompose a feature into slices mapped to personas and systems
 */
export function decompose(request: string): DecompositionResult {
  const req = request.toLowerCase();

  // System analysis: which game systems does this touch?
  const systemsInvolved: string[] = [];

  if (/combat|damage|hit|attack|enemy/.test(req)) systemsInvolved.push('combat');
  if (/enemy|ai|behavior|pathfind/.test(req)) systemsInvolved.push('ai');
  if (/loot|drop|reward|chest|rare/.test(req)) systemsInvolved.push('loot');
  if (/progression|xp|level|tier|prestige/.test(req)) systemsInvolved.push('progression');
  if (/shop|buy|sell|currency|gold/.test(req)) systemsInvolved.push('economy');
  if (/floor|room|wave|spawn/.test(req)) systemsInvolved.push('floor-generation');
  if (/ui|menu|hud|button|screen/.test(req)) systemsInvolved.push('ui');
  if (/visual|sprite|vfx|particle|effect/.test(req)) systemsInvolved.push('graphics');
  if (/sound|audio|sfx|music/.test(req)) systemsInvolved.push('audio');
  if (/quest|objective|trigger|event/.test(req)) systemsInvolved.push('quests');
  if (/story|lore|dialogue|narrative/.test(req)) systemsInvolved.push('story');
  if (
    /component|pipeline|runtime|wire|wiring|headless|scene|ecs/.test(req) &&
    systemsInvolved.length > 0
  ) {
    systemsInvolved.push('core');
  }

  // Default to game/core systems if nothing specific matched
  if (systemsInvolved.length === 0) {
    systemsInvolved.push('game', 'core');
  }

  // Create slices based on systems and personas
  const slices: SliceDecomposition[] = [];
  const sliceId = (name: string) => name.toLowerCase().replace(/\s+/g, '-');

  // Persona-to-systems mapping — loaded from the single routing manifest
  // (`docs/agent-os/personas/routing.json`) so this file, the personas README,
  // and the docs guard can never disagree about who owns what.
  const routing = loadPersonaRouting();
  const personaMapping = systemsByPersona(routing);

  // Group systems by persona
  const personaWork: Record<string, string[]> = {};
  for (const system of systemsInvolved) {
    let assigned = false;
    for (const [persona, systems] of Object.entries(personaMapping)) {
      if (systems.includes(system)) {
        if (!personaWork[persona]) personaWork[persona] = [];
        personaWork[persona].push(system);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      // Unmapped systems are a routing gap, not game design. Surface them on
      // the manifest's triage persona so the gap is explicit instead of
      // silently landing on whichever persona happens to be listed first.
      const bucket = routing.unrouted_persona;
      if (!personaWork[bucket]) personaWork[bucket] = [];
      personaWork[bucket].push(system);
    }
  }

  // Create one slice per persona
  let sliceIndex = 1;
  for (const [persona, systems] of Object.entries(personaWork)) {
    const sid = sliceId(`${persona}-${sliceIndex}`);
    const apples = systems.length <= 2 ? 2 : 3; // Cap at 3 apples

    slices.push({
      id: sid,
      name: `${persona} work (${systems.join(', ')})`,
      persona,
      systems,
      apples,
      description: `Implement ${systems.join(', ')} for: ${request}`,
      dependencies: [],
    });
    sliceIndex++;
  }

  // Determine dependencies: UI/graphics/audio typically wait for core game logic
  const coreSlices = slices.filter((s) =>
    ['Game Designer', 'Systems Engineer'].includes(s.persona),
  );
  const uiSlices = slices.filter((s) => s.persona === 'UX Designer');
  const graphicsSlices = slices.filter((s) => s.persona === 'Graphics Designer');
  const gameAiSlices = slices.filter((s) => s.persona === 'Game AI Engineer');

  // UI (including audio feedback) depends on core
  for (const slice of uiSlices) {
    slice.dependencies = coreSlices.map((s) => s.id);
  }

  // Graphics depends on core
  for (const slice of graphicsSlices) {
    slice.dependencies = coreSlices.map((s) => s.id);
  }

  // Enemy AI depends on core
  for (const slice of gameAiSlices) {
    slice.dependencies = coreSlices.map((s) => s.id);
  }

  // Content/story can be parallel (no dependencies unless it references game systems)

  // Compute parallelizable groups
  const parallelizableGroups: string[][] = [];
  const processed = new Set<string>();

  for (const slice of slices) {
    if (!processed.has(slice.id)) {
      // Find all slices with same dependencies
      const group = slices.filter(
        (s) =>
          JSON.stringify(s.dependencies.slice().sort()) ===
          JSON.stringify(slice.dependencies.slice().sort()),
      );
      parallelizableGroups.push(group.map((g) => g.id));
      group.forEach((g) => processed.add(g.id));
    }
  }

  // Collect root slices (those with no dependencies — the DAG entry points)
  const criticalPath: string[] = [];
  for (const slice of slices) {
    if (slice.dependencies.length === 0) {
      criticalPath.push(slice.id);
    }
  }

  const totalApples = slices.reduce((sum, s) => sum + s.apples, 0);

  const result: DecompositionResult = {
    feature: request,
    slices,
    totalApples,
    criticalPath,
    parallelizableGroups,
    escalations: [],
    contract: inferPlanningContract(request, slices),
  };
  result.contract.validationErrors = [
    ...new Set([...result.contract.validationErrors, ...validateDecomposition(result)]),
  ];
  result.contract.readyForDelegation =
    result.contract.gateStatus === 'READY' && result.contract.validationErrors.length === 0;
  return result;
}

/**
 * Command: --decompose
 * Decompose a feature into parallelizable slices
 */
function handleDecompose(request: string): void {
  const triageResult = triage(request);
  if (triageResult.escalation === 'HUMAN_GATE' || triageResult.requestType === 'UNCLEAR') {
    console.log('\n⛔ DECOMPOSITION BLOCKED\n');
    console.log(
      `Request classified as ${triageResult.requestType} (${triageResult.escalation ?? 'n/a'}).`,
    );
    console.log('Resolve required human clarification/approval before decomposition.\n');
    return;
  }
  if (triageResult.requestType !== 'FEATURE') {
    console.log('\n⛔ DECOMPOSITION BLOCKED\n');
    console.log(
      `Request classified as ${triageResult.requestType}. Decomposition is only for FEATURE requests.\n`,
    );
    return;
  }

  const result = decompose(request);

  console.log('\n🎯 PRODUCER DECOMPOSITION\n');
  console.log(`Feature: "${result.feature}"`);
  console.log(`Total Apple Estimate: ${result.totalApples}🍎`);
  console.log(`Slices: ${result.slices.length}`);
  console.log(`Parallelizable Groups: ${result.parallelizableGroups.length}`);
  console.log(
    `Hard gate: ${result.contract.hardGate ?? 'MISSING — clarify a measurable success condition before delegation'}`,
  );
  console.log(`Planning confidence: ${Math.round(result.contract.confidence * 100)}%`);
  console.log('Tiebreakers:');
  result.contract.rankedTiebreakers.forEach((tiebreaker, index) =>
    console.log(`  ${index + 1}. ${tiebreaker}`),
  );
  if (!result.contract.readyForDelegation) {
    console.log('Delegation: BLOCKED until the planning contract is complete and valid.');
  }

  if (result.totalApples > 12) {
    console.log(
      '\n⚠️  WARNING: Total apples > 12. Consider further decomposition or human review.',
    );
  }

  if (result.slices.length > 8) {
    console.log('\n⚠️  WARNING: More than 8 slices. Escalate to human for scope review.');
  }

  console.log('\n📋 SLICES:\n');
  for (const slice of result.slices) {
    const deps =
      slice.dependencies.length > 0
        ? ` (depends on: ${slice.dependencies.join(', ')})`
        : ' (independent)';
    console.log(`  ${slice.id}`);
    console.log(`    Persona: ${slice.persona}`);
    console.log(`    Systems: ${slice.systems.join(', ')}`);
    console.log(`    Apples: ${slice.apples}🍎`);
    console.log(`    ${slice.description}${deps}\n`);
  }

  console.log('🔗 PARALLELIZABLE GROUPS:\n');
  for (let i = 0; i < result.parallelizableGroups.length; i++) {
    const group = result.parallelizableGroups[i];
    if (group) {
      console.log(`  Group ${i + 1}: ${group.join(', ')}\n`);
    }
  }

  if (result.escalations.length > 0) {
    console.log('\n⚠️  ESCALATIONS:');
    for (const escalation of result.escalations) {
      console.log(`  - ${escalation}`);
    }
  }

  const initialSlices: Slice[] = result.slices.map((slice) => ({
    name: slice.name,
    persona: slice.persona,
    apple_tier: slice.apples,
    dependencies: slice.dependencies,
    description: slice.description,
    status: slice.dependencies.length > 0 ? 'BLOCKED_UPSTREAM' : 'PENDING',
    created_at: new Date().toISOString(),
  }));
  const state: OrchestrationState = {
    schema: 'producer-orchestration-state/v1',
    timestamp: new Date().toISOString(),
    session_id: getSessionId(),
    feature: request,
    triage_type: 'FEATURE',
    slices: initialSlices,
    overall_progress: 0,
    cloud_recovery_handoffs: 0,
    blockers: result.contract.hardGate
      ? result.escalations
      : ['Define a measurable hard gate before delegating slices.'],
    contract_status: result.contract.gateStatus,
    hard_gate: result.contract.hardGate ?? undefined,
  };
  appendJsonlLine(ORCHESTRATION_FILE, state);
  const event: ProducerEvent = {
    schema: 'producer-orchestration-event/v1',
    timestamp: new Date().toISOString(),
    session_id: state.session_id,
    event: 'decompose_completed',
    feature: request,
    details: {
      slice_count: result.slices.length,
      total_apples: result.totalApples,
      parallel_groups: result.parallelizableGroups.length,
    },
  };
  appendJsonlLine(ORCHESTRATION_FILE, event);
  console.log('📝 Orchestration snapshot saved to files/producer-orchestration.jsonl\n');
}

/**
 * Command: --force-publish
 * Publish a draft PR immediately, arm auto-merge, and release the owning session.
 */
function handleForcePublish(prNumberText: string): void {
  const prNumber = Number(prNumberText);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    console.error('Error: --force-publish requires a positive numeric PR number');
    process.exit(1);
  }

  const sessionId = getSessionId();
  appendJsonlLine(ORCHESTRATION_FILE, {
    schema: 'producer-orchestration-event/v1',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    event: 'force_publish_requested',
    pr_number: prNumber,
  } satisfies ProducerEvent);

  let isDraft = false;
  let headRef = '';
  try {
    const viewRaw = execFileSync(
      'gh',
      ['pr', 'view', String(prNumber), '--json', 'isDraft,headRefName,url,title'],
      { encoding: 'utf-8' },
    );
    const parsed = JSON.parse(viewRaw) as {
      isDraft?: boolean;
      headRefName?: string;
      url?: string;
      title?: string;
    };
    isDraft = parsed.isDraft === true;
    headRef = parsed.headRefName || '';
    console.log(`\nPR #${prNumber}: ${parsed.title || '(untitled)'}`);
    if (parsed.url) console.log(parsed.url);
  } catch (err) {
    console.error(`Unable to query PR #${prNumber}: ${err}`);
    process.exit(1);
  }

  if (isDraft) {
    try {
      execFileSync('gh', ['pr', 'ready', String(prNumber)], { stdio: 'inherit' });
    } catch (err) {
      appendJsonlLine(ORCHESTRATION_FILE, {
        schema: 'producer-orchestration-event/v1',
        timestamp: new Date().toISOString(),
        session_id: sessionId,
        event: 'force_publish_failed',
        pr_number: prNumber,
        details: { step: 'publish', error: String(err) },
      } satisfies ProducerEvent);
      console.error(`Failed to publish draft PR #${prNumber}: ${err}`);
      process.exit(1);
    }
    appendJsonlLine(ORCHESTRATION_FILE, {
      schema: 'producer-orchestration-event/v1',
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      event: 'pr_published',
      pr_number: prNumber,
    } satisfies ProducerEvent);
    console.log(`✅ Published PR #${prNumber} from draft.`);
  } else {
    console.log(`ℹ️ PR #${prNumber} is already published.`);
  }

  // Arm autonomous merge immediately per policy.
  try {
    execFileSync('gh', ['pr', 'merge', String(prNumber), '--auto', '--squash'], {
      stdio: 'inherit',
    });
  } catch (err) {
    appendJsonlLine(ORCHESTRATION_FILE, {
      schema: 'producer-orchestration-event/v1',
      timestamp: new Date().toISOString(),
      session_id: sessionId,
      event: 'force_publish_failed',
      pr_number: prNumber,
      details: { step: 'arm_auto_merge', error: String(err) },
    } satisfies ProducerEvent);
    console.error(
      `PR #${prNumber} may be published but auto-merge could not be armed: ${String(err)}`,
    );
    process.exit(1);
  }
  appendJsonlLine(ORCHESTRATION_FILE, {
    schema: 'producer-orchestration-event/v1',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    event: 'auto_merge_armed',
    pr_number: prNumber,
    details: headRef ? { branch: headRef } : undefined,
  } satisfies ProducerEvent);

  // Record session release — CI Recovery will assign cloud Copilot for any blockers.
  appendJsonlLine(ORCHESTRATION_FILE, {
    schema: 'producer-orchestration-event/v1',
    timestamp: new Date().toISOString(),
    session_id: sessionId,
    event: 'session_released',
    pr_number: prNumber,
    details: {
      mode: 'cloud_recovery',
      note: 'Session released; CI Recovery assigns cloud Copilot for post-publication blockers.',
    },
  } satisfies ProducerEvent);
  console.log('☁️ Session released — CI Recovery will assign cloud Copilot for any blockers.\n');
}

/**
 * Parse CLI arguments and route to handlers
 */
function main(): void {
  const { values } = parseArgs({
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
    handleDecompose(values.decompose);
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
    handleForcePublish(values.pr);
    process.exit(0);
  }

  console.log('Producer Skill CLI\nRun with --help for usage information');
  process.exit(0);
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`producer crashed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  }
}
