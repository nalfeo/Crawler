/**
 * docs/handoff-parse.ts — Shared, side-effect-free primitives for parsing the
 * trimmed handoff format (see docs/knowledge/handoffs/TEMPLATE.md).
 *
 * `lint-handoff.ts` and `promote-mistakes.ts` both need to agree, by
 * construction, on:
 *  - what counts as an empty / placeholder subsection, and
 *  - how the `## Retrospective` subsections are delimited.
 *
 * They previously each carried private copies of `PLACEHOLDER_TOKENS`,
 * `stripHtmlComments`, and `isProseLine`, and `promote-mistakes.ts` scanned for
 * `### Mistakes Made` anywhere in the document rather than scoping it to the
 * retrospective block. Centralising the logic here keeps the lint gate and the
 * promotion pass in lock-step and makes the parsing unit-testable in isolation
 * (this module has no top-level `main()`, unlike the two CLIs).
 */

/**
 * Lower-cased tokens treated as "no real content". A subsection whose only
 * prose is one of these (optionally as a bullet, optionally with trailing
 * punctuation) is considered empty.
 */
export const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  '',
  '-',
  '—',
  '–',
  'none',
  'n/a',
  'na',
  'tbd',
  'todo',
  '?',
  '???',
  'nothing',
]);

export interface Subsection {
  readonly title: string;
  readonly lines: readonly string[];
}

export function stripHtmlComments(body: string): string {
  return body.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * True when `line` carries substantive prose (i.e. is not blank, markdown
 * decoration, or a single placeholder token such as `None` / `TBD`).
 */
export function isProseLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  // Reject lines that are just markdown decoration.
  if (/^[-*_=]{1,}$/.test(trimmed)) return false;
  // Single-word placeholder (allow trailing punctuation).
  const token = trimmed.replace(/[.!?,;:]+$/g, '').toLowerCase();
  if (PLACEHOLDER_TOKENS.has(token)) return false;
  // Bullet with just a placeholder inside.
  const bulletBody = trimmed
    .replace(/^[-*+]\s+/, '')
    .replace(/[.!?,;:]+$/g, '')
    .toLowerCase();
  if (PLACEHOLDER_TOKENS.has(bulletBody)) return false;
  return true;
}

/**
 * Extract the `### ...` subsections that live under the first `## Retrospective`
 * heading. Returns `[]` when the document has no `## Retrospective` section
 * (legacy handoffs that predate the retrospective requirement).
 */
export function extractRetrospectiveSubsections(md: string): Subsection[] {
  const lines = md.split(/\r?\n/);
  const retroIdx = lines.findIndex((l) => /^##\s+Retrospective\b/i.test(l));
  if (retroIdx === -1) return [];
  const results: Subsection[] = [];
  let cursor = retroIdx + 1;
  while (cursor < lines.length) {
    if (/^##\s+/.test(lines[cursor]!) && !/^###/.test(lines[cursor]!)) break;
    const h3Match = /^###\s+(.+?)\s*$/.exec(lines[cursor]!);
    if (!h3Match) {
      cursor += 1;
      continue;
    }
    const title = h3Match[1]!.trim();
    const bodyStart = cursor + 1;
    let bodyEnd = bodyStart;
    while (bodyEnd < lines.length) {
      if (/^###\s+/.test(lines[bodyEnd]!)) break;
      if (/^##\s+/.test(lines[bodyEnd]!) && !/^###/.test(lines[bodyEnd]!)) break;
      bodyEnd += 1;
    }
    results.push({ title, lines: lines.slice(bodyStart, bodyEnd) });
    cursor = bodyEnd;
  }
  return results;
}

export function subsectionIsEmpty(sub: Subsection): boolean {
  const cleaned = stripHtmlComments(sub.lines.join('\n'));
  const proseLines = cleaned.split(/\r?\n/).filter(isProseLine);
  return proseLines.length === 0;
}

/**
 * Find a specific `### <title>` subsection under `## Retrospective`
 * (case-insensitive on the title). Returns `null` when the document has no
 * `## Retrospective` section or the subsection is absent.
 */
export function findRetrospectiveSubsection(md: string, title: string): Subsection | null {
  const wanted = title.toLowerCase();
  return extractRetrospectiveSubsections(md).find((s) => s.title.toLowerCase() === wanted) ?? null;
}

/**
 * Return the substantive prose lines of a subsection (HTML comments stripped,
 * placeholder/decoration lines removed). Empty array when there is none.
 */
export function proseLinesOf(sub: Subsection): string[] {
  const cleaned = stripHtmlComments(sub.lines.join('\n'));
  return cleaned.split(/\r?\n/).filter(isProseLine);
}
