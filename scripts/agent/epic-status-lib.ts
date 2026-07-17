/**
 * epic-status-lib.ts — Pure logic for the epic status CLI.
 *
 * All functions here are free of file I/O and process-level side effects so
 * they can be unit-tested directly. The thin `epic-status.ts` wrapper owns
 * file I/O and process exit.
 *
 * Terminology:
 *   - `SliceNode`  — one chunk of work (e.g. "slice:B2")
 *   - `EpicState`  — the full parsed + validated epic-state.json
 *   - "computed-ready" — a planned slice whose every dependency is validated
 *     or merged; these are the candidates for child-issue materialization
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schema (mirrors epic-state.schema.json)
// ---------------------------------------------------------------------------

const SliceStatusSchema = z.enum([
  'planned',
  'claimed',
  'in_progress',
  'merged',
  'validated',
  'deferred',
  'blocked',
]);

export type SliceStatus = z.infer<typeof SliceStatusSchema>;

const GateStatusSchema = z.enum(['pending', 'measuring', 'passed', 'failed']);

const commitShaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/)
  .nullable()
  .optional();

const GateCheckpointSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  label: z.string().min(1),
  target_min: z.number(),
  target_max: z.number(),
  measured_value: z.number().nullable().optional(),
  status: GateStatusSchema,
  evidence_commit: commitShaSchema,
});

export type GateCheckpoint = z.infer<typeof GateCheckpointSchema>;

const HardReleaseGateSchema = z.object({
  description: z.string().min(1),
  checkpoints: z.array(GateCheckpointSchema).min(1),
  status: GateStatusSchema,
  evidence_commit: commitShaSchema,
});

export type HardReleaseGate = z.infer<typeof HardReleaseGateSchema>;

const SliceNodeSchema = z.object({
  id: z.string().regex(/^slice:[A-Z][0-9]+$/),
  title: z.string().min(1),
  tier: z.enum(['A', 'B', 'C']),
  seq: z.number().int().min(0),
  status: SliceStatusSchema,
  scope: z.string().min(1),
  deferred: z.boolean(),
  github_issue: z.number().int().positive().nullable().optional(),
  pr: z.number().int().positive().nullable().optional(),
  commit_evidence: commitShaSchema,
  dependencies: z.array(z.string().regex(/^slice:[A-Z][0-9]+$/)),
  notes: z.string().optional(),
});

export type SliceNode = z.infer<typeof SliceNodeSchema>;

const EpicStateSchema = z.object({
  $schema: z.string().optional(),
  epic_id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  github_issue: z.number().int().positive().nullable().optional(),
  schema_version: z.string().regex(/^\d+\.\d+\.\d+$/),
  updated_at: z.string().datetime(),
  hard_release_gate: HardReleaseGateSchema,
  slices: z.array(SliceNodeSchema).min(1),
});

export type EpicState = z.infer<typeof EpicStateSchema>;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Parse and validate a raw JSON value against the EpicState schema.
 * Throws a descriptive error on validation failure.
 * Also checks:
 *   - Duplicate slice IDs
 *   - Duplicate gate checkpoint IDs
 *   - Referential integrity (all dep IDs exist)
 *   - No self-references in dependencies
 *   - No cycles in the dependency DAG
 */
export function validateEpicState(raw: unknown): EpicState {
  const result = EpicStateSchema.safeParse(raw);
  if (!result.success) {
    const msgs = result.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Epic state validation failed:\n${msgs}`);
  }
  const data = result.data;

  // Duplicate slice ID check
  const ids = new Map<string, number>(); // id → first index
  for (let i = 0; i < data.slices.length; i++) {
    const id = data.slices[i]!.id;
    if (ids.has(id)) {
      throw new Error(`Duplicate slice id "${id}" at indices ${ids.get(id)} and ${i}`);
    }
    ids.set(id, i);
  }

  // Duplicate gate checkpoint ID check
  const cpIds = new Map<string, number>();
  for (let i = 0; i < data.hard_release_gate.checkpoints.length; i++) {
    const cpId = data.hard_release_gate.checkpoints[i]!.id;
    if (cpIds.has(cpId)) {
      throw new Error(
        `Duplicate gate checkpoint id "${cpId}" at indices ${cpIds.get(cpId)} and ${i}`,
      );
    }
    cpIds.set(cpId, i);
  }

  // Referential integrity + self-reference check
  for (const slice of data.slices) {
    for (const dep of slice.dependencies) {
      if (dep === slice.id) {
        throw new Error(`Slice ${slice.id} has a self-reference in its dependencies`);
      }
      if (!ids.has(dep)) {
        throw new Error(`Slice ${slice.id} has unknown dependency: ${dep}`);
      }
    }
  }

  // Cycle detection: topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>();
  const adjList = new Map<string, string[]>(); // dep → dependents
  for (const slice of data.slices) {
    if (!inDegree.has(slice.id)) inDegree.set(slice.id, 0);
    if (!adjList.has(slice.id)) adjList.set(slice.id, []);
    for (const dep of slice.dependencies) {
      inDegree.set(slice.id, (inDegree.get(slice.id) ?? 0) + 1);
      const dependents = adjList.get(dep) ?? [];
      dependents.push(slice.id);
      adjList.set(dep, dependents);
    }
  }
  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }
  let processed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    processed++;
    for (const dependent of adjList.get(current) ?? []) {
      const newDeg = (inDegree.get(dependent) ?? 0) - 1;
      inDegree.set(dependent, newDeg);
      if (newDeg === 0) queue.push(dependent);
    }
  }
  if (processed < data.slices.length) {
    throw new Error(
      `Dependency cycle detected in epic state: only ${processed} of ${data.slices.length} slices could be topologically sorted`,
    );
  }

  return data;
}

// ---------------------------------------------------------------------------
// Computed-ready logic
// ---------------------------------------------------------------------------

/** Statuses that count as "done" for dependency purposes. */
const DONE_STATUSES: ReadonlySet<SliceStatus> = new Set(['validated', 'merged']);

/**
 * Return the slices that are "computed-ready": their own status is `planned`,
 * they are not deferred, and every declared dependency is in a done status
 * (`validated` or `merged`).
 */
export function computeReadySlices(state: EpicState): readonly SliceNode[] {
  const statusById = new Map<string, SliceStatus>(state.slices.map((s) => [s.id, s.status]));
  return state.slices.filter((slice) => {
    if (slice.status !== 'planned') return false;
    if (slice.deferred) return false;
    return slice.dependencies.every((depId) => {
      const depStatus = statusById.get(depId);
      return depStatus !== undefined && DONE_STATUSES.has(depStatus);
    });
  });
}

// ---------------------------------------------------------------------------
// Status-table formatter
// ---------------------------------------------------------------------------

const STATUS_EMOJI: Record<SliceStatus, string> = {
  planned: '🕐',
  claimed: '📋',
  in_progress: '🔨',
  merged: '🔀',
  validated: '✅',
  deferred: '⏭️',
  blocked: '🚫',
};

const GATE_STATUS_EMOJI: Record<string, string> = {
  pending: '⏳',
  measuring: '📊',
  passed: '✅',
  failed: '❌',
};

/** Format the epic status as a human-readable text table. */
export function formatStatusTable(state: EpicState): string {
  const lines: string[] = [];

  lines.push(`${state.title} (#${state.github_issue ?? 'TBD'})`);
  lines.push(`Schema version: ${state.schema_version}   Updated: ${state.updated_at.slice(0, 10)}`);
  lines.push('');

  // --- Hard release gate ---
  const gate = state.hard_release_gate;
  lines.push(
    `Hard release gate: ${GATE_STATUS_EMOJI[gate.status] ?? gate.status} ${gate.status.toUpperCase()}`,
  );
  for (const cp of gate.checkpoints) {
    const measured =
      cp.measured_value != null ? `  measured: ${cp.measured_value.toFixed(2)}×` : '';
    lines.push(
      `  ${GATE_STATUS_EMOJI[cp.status] ?? cp.status} ${cp.label}: ` +
        `target ${cp.target_min}×–${cp.target_max}×${measured}`,
    );
  }
  lines.push('');

  // --- Slice table ---
  const ID_W = 12;
  const TITLE_W = 36;
  const STATUS_W = 14;
  const ISSUE_W = 7;
  const header =
    'ID'.padEnd(ID_W) +
    'TITLE'.padEnd(TITLE_W) +
    'STATUS'.padEnd(STATUS_W) +
    'ISSUE'.padEnd(ISSUE_W) +
    'DEPS';
  lines.push(header);
  lines.push('-'.repeat(header.length + 20));

  for (const slice of state.slices) {
    const emoji = STATUS_EMOJI[slice.status] ?? '?';
    const issueStr = slice.github_issue != null ? `#${slice.github_issue}` : '—';
    const depsStr =
      slice.dependencies.length === 0
        ? '—'
        : slice.dependencies.map((d) => d.replace('slice:', '')).join(', ');
    lines.push(
      slice.id.padEnd(ID_W) +
        slice.title.slice(0, TITLE_W - 1).padEnd(TITLE_W) +
        `${emoji} ${slice.status}`.padEnd(STATUS_W) +
        issueStr.padEnd(ISSUE_W) +
        depsStr,
    );
  }
  lines.push('');

  // --- Computed-ready ---
  const ready = computeReadySlices(state);
  if (ready.length > 0) {
    const ids = ready.map((s) => s.id.replace('slice:', '')).join(', ');
    lines.push(`Computed-ready queue (materialization candidates): ${ids}`);
  } else {
    lines.push('Computed-ready queue: (none)');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Materialization-plan formatter
// ---------------------------------------------------------------------------

/**
 * Format a markdown materialization plan listing computed-ready slices
 * (candidates for child-issue creation) and blocked slices (with their
 * unresolved dependency list).
 */
export function formatMaterializationPlan(state: EpicState): string {
  const statusById = new Map<string, SliceStatus>(state.slices.map((s) => [s.id, s.status]));
  const ready = computeReadySlices(state);

  const blockedPlanned = state.slices.filter((s) => {
    if (s.status !== 'planned') return false;
    if (s.deferred) return false;
    return s.dependencies.some((dep) => {
      const depStatus = statusById.get(dep);
      return depStatus === undefined || !DONE_STATUSES.has(depStatus);
    });
  });

  const lines: string[] = [];
  lines.push(`# Materialization plan — ${state.title} epic`);
  lines.push(`Parent issue: #${state.github_issue ?? 'TBD'}`);
  lines.push('');

  // --- Ready ---
  lines.push(`## Computed-ready slices (create as child issues now)`);
  lines.push('');
  if (ready.length === 0) {
    lines.push('_No slices are currently computed-ready._');
    lines.push('');
  } else {
    for (const slice of ready) {
      lines.push(`### ${slice.id} — ${slice.title}`);
      lines.push('');
      lines.push(`**Scope:** ${slice.scope}`);
      lines.push('');
      lines.push(
        `**Dependencies:** ${slice.dependencies.length === 0 ? 'none' : slice.dependencies.join(', ')} (all validated)`,
      );
      lines.push('');
      lines.push('**Suggested issue title:**');
      lines.push('```');
      lines.push(`feat(${state.epic_id}): ${slice.title} (${slice.id})`);
      lines.push('```');
      lines.push('');
    }
  }

  // --- Blocked ---
  lines.push('## Blocked slices (waiting on dependencies)');
  lines.push('');
  if (blockedPlanned.length === 0) {
    lines.push('_No slices are currently blocked._');
    lines.push('');
  } else {
    for (const slice of blockedPlanned) {
      const unresolved = slice.dependencies.filter((dep) => {
        const depStatus = statusById.get(dep);
        return depStatus === undefined || !DONE_STATUSES.has(depStatus);
      });
      lines.push(`### ${slice.id} — ${slice.title}`);
      lines.push(
        `Waiting on: ${unresolved
          .map((d) => {
            const s = statusById.get(d) ?? 'unknown';
            return `${d} (${s})`;
          })
          .join(', ')}`,
      );
      lines.push('');
    }
  }

  // --- Non-planned ---
  const nonPlanned = state.slices.filter(
    (s) => s.status !== 'planned' && s.status !== 'validated' && s.status !== 'merged',
  );
  if (nonPlanned.length > 0) {
    lines.push('## Active / deferred / blocked slices');
    lines.push('');
    for (const slice of nonPlanned) {
      lines.push(`- ${slice.id} (${slice.status}): ${slice.title}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
