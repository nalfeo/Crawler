#!/usr/bin/env node
/**
 * floor-epic-lint.ts — Deterministic gate for the Floor Factory agent's one
 * authored artifact: `docs/knowledge/epics/<epic-id>/<epic-id>.epic.json`.
 *
 * This is intentionally layered on top of, not a replacement for, the generic
 * schema/DAG validator (`validateEpicFile`, which itself internally runs
 * `topoSortNodes` and reports a dependency cycle as a schema error, in
 * `.github/scripts/epics/epic-create.mjs`) that every `*.epic.json` file must
 * already satisfy to be materialized into GitHub issues. This module adds the
 * floor-specific planning invariants from the Floor Factory doctrine
 * (`.github/agents/floor-factory.agent.md`) that a generic epic does not
 * require:
 *
 *   - one measurable, dual-runner spawn-to-win hard gate;
 *   - ranked non-goals/tiebreakers;
 *   - explicit HUMAN_GATE deferrals for numeric balance/fun decisions;
 *   - every node tagged with exactly one specialist-persona owner;
 *   - a node that proves headless + visual AI Runner completion together;
 *   - an owned, dependency-ordered achievement slice with measurable reward
 *     unlock/claim acceptance;
 *   - a single terminal release/MVP slice gated behind that proof;
 *   - no floor-ID branch smell in shared runtime paths;
 *   - an eight-slice cap unless a human-approved exception is recorded.
 *
 * These checks are deliberately pattern/field-based (not an LLM judge) so
 * they run the same way in CI as they do for a human reading the diff. See
 * `tests/unit/agent/floor-epic-lint.test.ts` for the fixture-backed
 * regression coverage (one violated invariant per mutated fixture).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { loadPersonaRouting } from '../shared/persona-routing.js';

/**
 * Reused from the plain-JS `epic-create.mjs` (not re-implemented) via a
 * dynamic import + explicit cast: it is a `.mjs` file, and the repo-wide
 * ambient `declare module '*.mjs'` (in
 * `scripts/agent/review/arbitrary-screenshot-lib-types.ts`) is shared across
 * every `.mjs` import site, so a static named import here would collide with
 * that shared type shape instead of this module's actual exports.
 */
interface EpicCreateModule {
  validateEpicFile(epic: unknown): string[];
}
const epicCreateModule =
  (await import('../../../.github/scripts/epics/epic-create.mjs')) as unknown as EpicCreateModule;
const { validateEpicFile } = epicCreateModule;

export interface FloorEpicNode {
  readonly id: string;
  readonly title: string;
  readonly body?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly depends_on?: ReadonlyArray<string>;
}

/**
 * Shape of a `*.epic.json` file authored by the Floor Factory agent. The
 * `hard_gate` / `non_goals` / `human_gates` / `human_approved_exception*`
 * fields are additive to the generic epic schema (which is permissive of
 * extra top-level fields) so a floor epic still materializes correctly
 * through the unmodified `epic-create.yml` workflow.
 */
export interface FloorEpic {
  readonly epic_id: string;
  readonly title: string;
  readonly description?: string;
  readonly hard_gate?: string;
  readonly non_goals?: ReadonlyArray<string>;
  readonly human_gates?: ReadonlyArray<string>;
  readonly human_approved_exception_reason?: string;
  readonly labels?: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<FloorEpicNode>;
  readonly [key: string]: unknown;
}

export interface FloorEpicViolation {
  readonly code: string;
  readonly message: string;
}

/**
 * The Floor Factory agent's only authored artifact, per its output contract:
 * `docs/knowledge/epics/<epic-id>/<epic-id>.epic.json`.
 */
export function canonicalFloorEpicPath(epicId: string): string {
  return `docs/knowledge/epics/${epicId}/${epicId}.epic.json`;
}

const MAX_SLICES_WITHOUT_EXCEPTION = 8;
const OWNER_LINE = /^Owner:\s*([^.\n]+)\./;
/**
 * Matches the common floor-ID branch forms the doctrine rejects in shared
 * runtime paths: string/numeric equality or inequality comparisons
 * (`floorId === 'floor9'`, `world.floor !== 'floor3'`, `world.floor === 9`)
 * and `switch (floorId)` dispatch.
 */
const FLOOR_BRANCH_SMELL =
  /\bfloor(id)?\s*(?:===|!==|==|!=)\s*(['"`]|\d)|\bswitch\s*\([^)]*\bfloor(id)?\b[^)]*\)/i;
/**
 * The doctrine's only carve-out for a floor-ID branch: "unless a documented
 * ADR proves no composable alternative exists" — require a concrete
 * reference to a real ADR file, not just the word "ADR".
 */
const ADR_REFERENCE = /docs\/knowledge\/adr\/\d{4}-\d{2}-\d{2}-[\w-]+\.md/;
const BALANCE_OWNERSHIP_SMELL =
  /\b(tune|tunes|tuning|balance|balancing|nerf|buff)\b[^.]{0,60}\b(damage|economy|difficulty|spawn[- ]rate|pacing|win[- ]rate)\b/i;
const PLAYABILITY_STAGE_WORDS = [
  'scaffolded',
  'bootable',
  'playable',
  'completable',
  'mvp',
  'released',
];

function nodeBodies(epic: FloorEpic): ReadonlyArray<{ node: FloorEpicNode; body: string }> {
  return epic.nodes.map((node) => ({ node, body: node.body ?? '' }));
}

function allText(epic: FloorEpic): string {
  return [
    epic.description ?? '',
    epic.hard_gate ?? '',
    ...(epic.non_goals ?? []),
    ...(epic.human_gates ?? []),
    ...epic.nodes.map((n) => `${n.title}\n${n.body ?? ''}`),
  ].join('\n');
}

/** Nodes no other node lists in `depends_on` — the sinks of the DAG. */
function terminalNodes(nodes: ReadonlyArray<FloorEpicNode>): ReadonlyArray<FloorEpicNode> {
  const depended = new Set<string>();
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) depended.add(dep);
  }
  return nodes.filter((node) => !depended.has(node.id));
}

function isDualRunnerProofNode(body: string): boolean {
  const mentionsHeadless = /\bheadless\b/i.test(body);
  const mentionsVisual = /\bvisual\b/i.test(body);
  const mentionsAiRunner = /\bai runner\b/i.test(body);
  const mentionsSpawn = /\bspawn\b/i.test(body);
  const mentionsWinVictory = /\b(win|victory)\b/i.test(body);
  return (
    mentionsHeadless && mentionsVisual && mentionsAiRunner && mentionsSpawn && mentionsWinVictory
  );
}

function isAchievementNode(node: FloorEpicNode): boolean {
  return /\bachievements?\b/i.test(`${node.title}\n${node.body ?? ''}`);
}

function achievementViolations(epic: FloorEpic): FloorEpicViolation[] {
  const achievementNodes = epic.nodes.filter(isAchievementNode);
  if (achievementNodes.length === 0) {
    return [
      {
        code: 'achievement-slice-missing',
        message:
          'epic must include an owned achievement slice or achievement-integrated QA slice.',
      },
    ];
  }

  const violations: FloorEpicViolation[] = [];
  for (const node of achievementNodes) {
    const body = node.body ?? '';
    if ((node.depends_on ?? []).length === 0) {
      violations.push({
        code: 'achievement-dependency-missing',
        message: `achievement node "${node.id}" must depend on its prerequisite floor mechanics.`,
      });
    }
    if (!/\b(unlock|claim|claimed|reward|rewards)\b/i.test(body)) {
      violations.push({
        code: 'achievement-acceptance-missing',
        message: `achievement node "${node.id}" must define measurable unlock/claim or reward acceptance.`,
      });
    }
    if (
      !/\b(done when|acceptance|assert|at least|at most|exactly|zero|threshold|verified|pass(?:es|ed)?)\b/i.test(
        body,
      )
    ) {
      violations.push({
        code: 'achievement-acceptance-missing',
        message: `achievement node "${node.id}" must include a measurable acceptance condition.`,
      });
    }
  }
  return violations;
}

/**
 * True when `text` contains a floor-ID branch smell that is NOT excused by
 * a documented ADR reference (the doctrine's only permitted exception).
 */
function hasUnexcusedFloorBranchSmell(text: string): boolean {
  return FLOOR_BRANCH_SMELL.test(text) && !ADR_REFERENCE.test(text);
}

/**
 * Validates the additive floor-epic fields are the expected primitive
 * shapes before any check reads them. The generic `validateEpicFile` schema
 * does not know about these fields, so a malformed value (e.g.
 * `hard_gate: 42`) would otherwise reach `.trim()`/`.some()`/spread and
 * throw instead of producing a deterministic violation.
 */
function additiveFieldTypeErrors(epic: FloorEpic): string[] {
  const errors: string[] = [];
  const isStringArray = (value: unknown): value is ReadonlyArray<string> =>
    Array.isArray(value) && value.every((item) => typeof item === 'string');

  if (epic.hard_gate !== undefined && typeof epic.hard_gate !== 'string') {
    errors.push('epic.hard_gate must be a string when present.');
  }
  if (epic.non_goals !== undefined && !isStringArray(epic.non_goals)) {
    errors.push('epic.non_goals must be an array of strings when present.');
  }
  if (epic.human_gates !== undefined && !isStringArray(epic.human_gates)) {
    errors.push('epic.human_gates must be an array of strings when present.');
  }
  if (
    epic.human_approved_exception_reason !== undefined &&
    typeof epic.human_approved_exception_reason !== 'string'
  ) {
    errors.push('epic.human_approved_exception_reason must be a string when present.');
  }
  if (epic.labels !== undefined && !isStringArray(epic.labels)) {
    errors.push('epic.labels must be an array of strings when present.');
  }
  return errors;
}

/**
 * The Floor Factory agent's output contract requires the epic file to live
 * exactly at `canonicalFloorEpicPath(epic.epic_id)`. Returns `null` when
 * `filePath` matches (or `epic.epic_id` isn't validatable, which
 * `validateEpicFile`'s schema check already covers) and a violation
 * otherwise.
 *
 * Both `filePath` and the canonical path are resolved with `node:path`'s
 * `resolve()`, which anchors a relative path to `process.cwd()`. Because
 * both resolutions happen within the same CLI invocation, they always share
 * the same `cwd` — so a relative `filePath` given on the command line is
 * compared against the canonical path interpreted relative to that exact
 * same working directory, matching how `readFileSync(filePath, ...)`
 * already interprets the argument. This intentionally does NOT hardcode a
 * repo-root anchor, so the check keeps working when the CLI is exercised
 * against a repo checked out somewhere other than this module's own path
 * (e.g. from a fixture directory in a test).
 */
export function outputPathViolation(filePath: string, epic: FloorEpic): FloorEpicViolation | null {
  if (typeof epic.epic_id !== 'string' || epic.epic_id.trim().length === 0) return null;
  const expected = canonicalFloorEpicPath(epic.epic_id);
  if (resolve(filePath) === resolve(expected)) return null;
  return {
    code: 'output-path-mismatch',
    message: `epic must be saved at ${expected} (got ${filePath}).`,
  };
}

/**
 * Lint a parsed floor epic document. Returns an empty array when the file
 * satisfies every Floor Factory planning invariant. Callers that also need
 * generic schema/DAG validation should run `validateEpicFile` first — this
 * function assumes (and re-derives, defensively) an acyclic graph.
 */
export function lintFloorEpic(
  epic: FloorEpic,
  personaNames: ReadonlyArray<string> = loadPersonaRouting().personas.map((p) => p.name),
): FloorEpicViolation[] {
  const violations: FloorEpicViolation[] = [];
  const push = (code: string, message: string) => violations.push({ code, message });

  const schemaErrors = validateEpicFile(epic as unknown as Record<string, unknown>);
  if (schemaErrors.length > 0) {
    for (const message of schemaErrors) push('schema', message);
    // The remaining checks assume a structurally valid, acyclic node array;
    // bail out early rather than reporting confusing derived failures.
    return violations;
  }

  // The generic schema doesn't know about the Floor-Factory-additive fields
  // (hard_gate/non_goals/human_gates/...); validate their primitive shapes
  // before any check below reads them, or a malformed value would throw
  // instead of producing a deterministic violation.
  const typeErrors = additiveFieldTypeErrors(epic);
  if (typeErrors.length > 0) {
    for (const message of typeErrors) push('schema', message);
    return violations;
  }

  // Hard gate: one measurable, dual-runner spawn-to-win statement.
  const hardGate = epic.hard_gate ?? '';
  if (hardGate.trim().length === 0) {
    push('hard-gate-missing', 'epic.hard_gate must be a non-empty, measurable spawn-to-win gate.');
  } else {
    if (!/\bspawn\b/i.test(hardGate)) {
      push(
        'hard-gate-not-spawn-to-win',
        'epic.hard_gate must describe the gate starting at spawn.',
      );
    }
    if (!/\b(win|victory)\b/i.test(hardGate)) {
      push(
        'hard-gate-not-spawn-to-win',
        'epic.hard_gate must describe reaching the real win/victory condition.',
      );
    }
    if (!/\bheadless\b/i.test(hardGate) || !/\b(ai runner|visual)\b/i.test(hardGate)) {
      push(
        'hard-gate-not-dual-runner',
        'epic.hard_gate must require BOTH the headless runner and the visual AI Runner to prove completion.',
      );
    }
  }

  // Ranked non-goals / tiebreakers.
  if (!epic.non_goals || epic.non_goals.length === 0) {
    push('non-goals-missing', 'epic.non_goals must list at least one ranked non-goal/tiebreaker.');
  }

  // Explicit HUMAN_GATE deferrals for numeric balance/fun decisions.
  const humanGates = epic.human_gates ?? [];
  if (humanGates.length === 0) {
    push(
      'human-gates-missing',
      'epic.human_gates must list at least one explicit HUMAN_GATE deferral for numeric balance/fun decisions.',
    );
  } else if (!humanGates.some((g) => /\b(playtester|game designer)\b/i.test(g))) {
    push(
      'human-gates-no-owner',
      'epic.human_gates must defer numeric balance/fun decisions to Playtester or Game Designer explicitly.',
    );
  }

  // Node count cap, escalation requires a recorded human-approved exception.
  if (
    epic.nodes.length > MAX_SLICES_WITHOUT_EXCEPTION &&
    (epic.human_approved_exception_reason ?? '').trim().length === 0
  ) {
    push(
      'slice-cap-exceeded',
      `epic has ${epic.nodes.length} slices (> ${MAX_SLICES_WITHOUT_EXCEPTION}) without a recorded human_approved_exception_reason.`,
    );
  }

  // Every node: exactly one specialist-persona owner tag, and no numeric
  // balance-ownership smell (that belongs behind a HUMAN_GATE, not a slice).
  const knownPersonas = new Set(personaNames);
  for (const { node, body } of nodeBodies(epic)) {
    const match = OWNER_LINE.exec(body.trim());
    if (!match) {
      push(
        'node-owner-missing',
        `node "${node.id}" body must start with "Owner: <Persona>." naming exactly one specialist persona.`,
      );
    } else if (!knownPersonas.has(match[1]!.trim())) {
      push(
        'node-owner-unknown',
        `node "${node.id}" Owner "${match[1]!.trim()}" is not a persona in docs/agent-os/personas/routing.json.`,
      );
    }
    if (BALANCE_OWNERSHIP_SMELL.test(body)) {
      push(
        'node-owns-balance',
        `node "${node.id}" reads as owning numeric balance/pacing directly; defer that decision to human_gates instead.`,
      );
    }
    if (hasUnexcusedFloorBranchSmell(body)) {
      push(
        'floor-branch-smell',
        `node "${node.id}" body contains a floor-ID branch smell with no documented ADR reference (docs/knowledge/adr/<date>-<slug>.md) proving no composable alternative exists; require config-driven/manifest composition instead.`,
      );
    }
  }
  if (hasUnexcusedFloorBranchSmell(epic.description ?? '')) {
    push(
      'floor-branch-smell',
      'epic.description contains a floor-ID branch smell with no documented ADR reference.',
    );
  }

  // Config-driven composition: at least one mention of the generic seam.
  if (!/\b(scenariodefinition|manifest)\b/i.test(allText(epic))) {
    push(
      'config-driven-composition-missing',
      'epic must reference ScenarioDefinition/manifest composition (no bespoke floor-ID branches).',
    );
  }

  // Dual-runner proof node.
  const proofNodes = epic.nodes.filter((n) => isDualRunnerProofNode(n.body ?? ''));
  if (proofNodes.length === 0) {
    push(
      'dual-runner-proof-missing',
      'no node body proves headless + visual AI Runner completion together (must mention "headless", "visual", "AI Runner", "spawn", and "win"/"victory").',
    );
  }

  for (const violation of achievementViolations(epic)) {
    violations.push(violation);
  }

  // Terminal release/MVP slice. Note: when there is exactly one terminal
  // node, every other node is necessarily its ancestor (a DAG can only have a
  // single sink if every node's forward chain feeds into it), so an existing
  // dual-runner proof node is always transitively depended on by the release
  // slice once uniqueness holds — no separate "gated on proof" check needed.
  const sinks = terminalNodes(epic.nodes);
  if (sinks.length !== 1) {
    push(
      'release-slice-not-unique-terminal',
      `epic must have exactly one terminal (no-dependents) slice; found ${sinks.length}.`,
    );
  } else {
    const [release] = sinks;
    const releaseNode = release!;
    if (!/\b(release|mvp)\b/i.test(releaseNode.body ?? '')) {
      push(
        'release-slice-not-final',
        `terminal node "${releaseNode.id}" must be the release/MVP-enablement slice.`,
      );
    }
  }

  // Progressive playability stages (scaffolded/bootable/playable/completable/
  // MVP/released) — the doctrine requires the plan to explicitly distinguish
  // ALL SIX stages, not merely a subset, or completable/MVP conflation (a
  // named regression lesson) can slip through unflagged.
  const text = allText(epic).toLowerCase();
  const stagesMentioned = PLAYABILITY_STAGE_WORDS.filter((word) => text.includes(word));
  if (stagesMentioned.length < PLAYABILITY_STAGE_WORDS.length) {
    const missing = PLAYABILITY_STAGE_WORDS.filter((word) => !stagesMentioned.includes(word));
    push(
      'playability-stages-underspecified',
      `epic must distinguish every stage: ${PLAYABILITY_STAGE_WORDS.join(', ')} (missing: ${missing.join(', ')}).`,
    );
  }

  return violations;
}

function main(): void {
  const file = process.argv[2];
  if (!file) {
    process.stderr.write('Usage: npm run epics:lint-floor -- <path-to-epic.json>\n');
    process.exitCode = 2;
    return;
  }
  const epic = JSON.parse(readFileSync(file, 'utf8')) as FloorEpic;
  // validateEpicFile already validates schema shape and, when the shape is
  // valid, internally runs topoSortNodes and reports any dependency cycle as
  // a schema error — so lintFloorEpic (which re-derives this same check and
  // bails out early on schema errors) is the single source of truth here.
  const violations = lintFloorEpic(epic);
  // The output-path check is CLI-only (it needs the actual file path, which
  // lintFloorEpic's pure-document signature deliberately does not take).
  const pathViolation = outputPathViolation(file, epic);
  if (pathViolation) violations.unshift(pathViolation);
  if (violations.length === 0) {
    process.stdout.write(`${file}: OK\n`);
    return;
  }
  for (const v of violations) {
    process.stdout.write(`[${v.code}] ${v.message}\n`);
  }
  process.exitCode = 1;
}

// `import.meta.url` is always a normalized `file:///...` URL, while
// `process.argv[1]` is a raw filesystem path (`C:\...` on Windows). Comparing
// them directly is false on Windows, so the CLI would import this module but
// never call `main()`. Convert argv[1] through `pathToFileURL` first.
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
