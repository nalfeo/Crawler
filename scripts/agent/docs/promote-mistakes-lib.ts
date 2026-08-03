/**
 * promote-mistakes-lib.ts — pure, dependency-free logic for promoting
 * `### Mistakes Made` blocks into the `Session_Mistakes` memory entity.
 *
 * Kept free of `node:fs` / `process` so the JSONL parse/serialize round-trip,
 * the mistake summarizer, and the slug-keyed idempotency can be unit-tested
 * directly. The thin `promote-mistakes.ts` wrapper owns all file I/O and
 * reporting, and reuses the retrospective parsing from `handoff-parse.ts`.
 */

export const ENTITY_NAME = 'Session_Mistakes';
export const ENTITY_TYPE = 'lessons';
/** Matches a dated handoff filename prefix (`YYYY-MM-DD-`). */
export const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;
/** Hard cap on a promoted observation so one handoff can't bloat the graph. */
export const MAX_LINE_LEN = 500;

export interface Entity {
  readonly type: 'entity';
  readonly name: string;
  readonly entityType: string;
  observations: string[];
}

export interface Relation {
  readonly type: 'relation';
  readonly from: string;
  readonly to: string;
  readonly relationType: string;
}

export type MemoryRecord = Entity | Relation;

export interface ParsedMemory {
  readonly records: MemoryRecord[];
  /** 1-based line numbers of non-empty lines that failed to parse as JSON. */
  readonly malformedLines: readonly number[];
}

/**
 * Collapse the prose lines of a `### Mistakes Made` block into one
 * semicolon-joined observation, stripped of list markers and truncated to
 * {@link MAX_LINE_LEN} (with an ellipsis on a word boundary).
 */
export function summarizeMistakes(lines: readonly string[]): string {
  const parts = lines.map((l) =>
    l
      .trim()
      .replace(/^[-*+]\s+/, '')
      .replace(/\s+/g, ' '),
  );
  let out = parts.join('; ');
  if (out.length > MAX_LINE_LEN) {
    out = `${out.slice(0, MAX_LINE_LEN - 1).replace(/\s+\S*$/, '')}…`;
  }
  return out;
}

/**
 * Parse newline-delimited JSON into records, recording (rather than dropping)
 * any non-empty line that fails to parse so the caller can refuse to rewrite a
 * file that would otherwise lose data.
 */
export function parseMemory(raw: string): ParsedMemory {
  const records: MemoryRecord[] = [];
  const malformedLines: number[] = [];
  const allLines = raw.split(/\r?\n/);
  for (let i = 0; i < allLines.length; i += 1) {
    const trimmed = allLines[i]!.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as MemoryRecord);
    } catch {
      malformedLines.push(i + 1);
    }
  }
  return { records, malformedLines };
}

export function serializeMemory(records: readonly MemoryRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export function slugFromFile(filename: string): string {
  return filename.replace(/\.md$/, '');
}

export function observationForSlug(slug: string, summary: string): string {
  return `[${slug}] ${summary}`;
}

export function extractSlugFromObservation(obs: string): string | null {
  const m = /^\[([^\]]+)\]/.exec(obs);
  return m ? m[1]! : null;
}

/** The set of handoff slugs already recorded on the entity (for idempotency). */
export function existingSlugs(entity: Entity): Set<string> {
  const slugs = new Set<string>();
  for (const obs of entity.observations) {
    const slug = extractSlugFromObservation(obs);
    if (slug) slugs.add(slug);
  }
  return slugs;
}

/**
 * Replace the `Session_Mistakes` entity in `records`, or insert it directly
 * after the last existing entity (keeping entities grouped ahead of relations,
 * matching the file's current layout) when it is new.
 */
export function upsertEntity(records: readonly MemoryRecord[], entity: Entity): MemoryRecord[] {
  const next: MemoryRecord[] = [];
  let replaced = false;
  for (const r of records) {
    if (r.type === 'entity' && r.name === entity.name) {
      if (!replaced) {
        next.push(entity);
        replaced = true;
      }
      // Drop subsequent duplicates — they should not exist, but guard against
      // a corrupted JSONL that already contains more than one copy.
    } else {
      next.push(r);
    }
  }
  if (!replaced) {
    let insertAt = next.length;
    for (let i = next.length - 1; i >= 0; i -= 1) {
      if (next[i]!.type === 'entity') {
        insertAt = i + 1;
        break;
      }
    }
    next.splice(insertAt, 0, entity);
  }
  return next;
}
