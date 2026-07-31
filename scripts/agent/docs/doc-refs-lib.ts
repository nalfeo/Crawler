import { parseDocument } from 'yaml';

/**
 * doc-refs-lib.ts — Pure reference-extraction helpers shared by the docs guards
 * (`check-paths.ts`, `check-personas.ts`).
 *
 * These are deliberately filesystem-free so they can be unit tested directly.
 * Anything that touches disk lives in the calling guard.
 */

const PATH_PREFIXES = [
  './',
  '/',
  'src/',
  'scripts/',
  'tests/',
  'docs/',
  '.github/',
  '.specify/',
  'public/',
  'briefs/',
  'data/',
  'tools/',
];

const PATH_EXTS = ['.ts', '.tsx', '.md', '.json', '.yml', '.yaml', '.sh'];

/** Does a backtick-quoted string look like a repo path we should verify? */
export function looksLikePath(s: string): boolean {
  if (s.includes(' ')) return false;
  if (s.startsWith('http') || s.startsWith('npm ') || s.startsWith('bash ')) return false;
  // Template placeholders like `<slug>` or `YYYY-MM-DD-` are documentation
  // patterns, not real paths.
  if (s.includes('<') || s.includes('>')) return false;
  if (/\bYYYY\b/.test(s)) return false;
  if (PATH_PREFIXES.some((p) => s.startsWith(p))) return true;
  // Extension-only matches must also contain a separator so bare filenames
  // mentioned in prose (e.g. `ci.yml`, `package.json`) aren't flagged.
  if (PATH_EXTS.some((ext) => s.endsWith(ext)) && s.includes('/')) return true;
  return false;
}

/**
 * For a glob like `foo/bar/*`, `foo/bar/**\/*.ts`, or `foo/bar/quests.*.json`,
 * return the deepest non-wildcard *directory* that must exist, or `null` when
 * the glob constrains nothing checkable.
 */
export function globParentDir(globPath: string): string | null {
  const firstWildcard = globPath.search(/[*?{]/);
  if (firstWildcard < 0) return globPath;
  const head = globPath.slice(0, firstWildcard);
  const lastSlash = head.lastIndexOf('/');
  if (lastSlash < 0) return null;
  const parent = head.slice(0, lastSlash);
  return parent === '' ? null : parent;
}

/**
 * Resolve a Markdown link target to a repo-relative path, or `null` when the
 * target is not a checkable local file reference (external URL, pure anchor,
 * mail link, template placeholder, or a path that escapes the repo root).
 */
export function resolveLinkTarget(doc: string, target: string): string | null {
  if (!target || target.startsWith('#')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return null; // http:, mailto:, etc.
  if (target.includes('<') || target.includes('>')) return null;
  const withoutAnchor = target.split('#')[0];
  if (!withoutAnchor) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(withoutAnchor);
  } catch {
    decoded = withoutAnchor;
  }
  const docDir = doc.includes('/') ? doc.slice(0, doc.lastIndexOf('/')) : '';
  const base = decoded.startsWith('/') ? decoded.slice(1) : `${docDir}/${decoded}`;
  const segments: string[] = [];
  for (const segment of base.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null; // escapes the repo root
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length > 0 ? segments.join('/') : null;
}

/** The set of `## <heading>` names present in a Markdown document. */
export function headingSet(text: string): Set<string> {
  const headings = new Set<string>();
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const wasInFence = fence !== null;
    fence = nextFenceState(fence, line);
    if (wasInFence || fence !== null) continue;
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && match[1]) headings.add(match[1]);
  }
  return headings;
}

/** Body of a `## <name>` section, up to the next `##` heading, or `null`. */
export function sectionBody(text: string, name: string): string | null {
  const lines = text.split('\n');
  const heading = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  let fence: string | null = null;
  let start = -1;
  for (const [index, line] of lines.entries()) {
    const wasInFence = fence !== null;
    fence = nextFenceState(fence, line);
    if (wasInFence || fence !== null) continue;
    if (heading.test(line)) {
      start = index;
      break;
    }
  }
  if (start < 0) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const wasInFence = fence !== null;
    fence = nextFenceState(fence, line);
    if (!wasInFence && fence === null && /^##\s+/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

/** Every distinct `<name>.agent.md` referenced in a chunk of Markdown, in order. */
export function referencedAgents(text: string): string[] {
  const found: string[] = [];
  const re = /([a-z0-9-]+\.agent\.md)(?![a-z0-9.-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/**
 * CommonMark-style fence tracking: a fence closes only on a marker of the same
 * character that is at least as long as the opening run. Returns the new fence
 * state, or the unchanged state when the line is not a fence delimiter.
 *
 * `state` is `null` outside a fence, otherwise the open fence's marker run.
 */
export function nextFenceState(state: string | null, line: string): string | null {
  const match = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || !match[1]) return state;
  const marker = match[1];
  if (state === null) {
    // An opening ``` fence may carry an info string; a ~~~ fence may too.
    return marker;
  }
  const sameChar = marker[0] === state[0];
  const longEnough = marker.length >= state.length;
  // A closing fence must be bare — no info string after the marker run.
  const bare = (match[2] ?? '').trim() === '';
  return sameChar && longEnough && bare ? null : state;
}

/** Every distinct persona doc referenced in a chunk of Markdown, in order. */
export function referencedPersonas(text: string): string[] {
  const found: string[] = [];
  // The negative lookahead stops `reviewer.mdx` / `reviewer.md.bak` from
  // satisfying a backlink check that is meant to name a real persona doc.
  const re = /docs\/agent-os\/personas\/([a-z0-9-]+\.md)(?![a-z0-9.-])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] && m[1] !== 'README.md' && !found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** Non-empty `description:` from a leading YAML frontmatter block, or `null`. */
export function frontmatterDescription(text: string): string | null {
  // Normalize CRLF first: a lone trailing `\r` on the final frontmatter line
  // makes the YAML parser report "Unexpected scalar at node end", which would
  // fail every agent file on a Windows checkout while passing on LF-only CI.
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(text.replace(/\r\n/g, '\n'));
  if (!match || !match[1]) return null;
  let parsed;
  try {
    parsed = parseDocument(match[1]);
  } catch {
    return null;
  }
  if (parsed.errors.length > 0) return null;
  const value = parsed.get('description');
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Data rows of the first GitHub-flavoured pipe table in `text`.
 *
 * Returns each row as its trimmed cells, skipping the header row and the
 * `| --- |` separator. Returns `[]` when no table is present.
 */
export function tableRows(text: string): string[][] {
  const rows: string[][] = [];
  let seenSeparator = false;
  let started = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      // A blank/prose line after the table has begun ends that table.
      if (started && trimmed.length === 0) break;
      continue;
    }
    started = true;
    const cells = trimmed
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim());
    if (!seenSeparator) {
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) seenSeparator = true;
      continue; // header row, or separator row itself
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * Persona/agent pairs parsed from a Routing Matrix table, **in row order and
 * without deduplication** so callers can detect a duplicated persona row.
 *
 * Expects the persona as the first bolded cell (`**Producer**`) and the agent
 * as the first backticked slug cell (`` `producer` ``). Rows missing either are
 * skipped — the caller compares the result against the routing manifest, so a
 * malformed row surfaces as a missing entry rather than a silent pass.
 */
export function routingMatrixRows(text: string): Array<{ persona: string; agent: string }> {
  const rows: Array<{ persona: string; agent: string }> = [];
  for (const cells of tableRows(text)) {
    let persona: string | null = null;
    let agent: string | null = null;
    for (const cell of cells) {
      if (persona === null) {
        const bold = /^\*\*(.+?)\*\*$/.exec(cell);
        if (bold?.[1]) {
          persona = bold[1].trim();
          continue;
        }
      }
      if (persona !== null && agent === null) {
        const code = /^`([a-z0-9-]+)`$/.exec(cell);
        if (code?.[1]) agent = code[1];
      }
    }
    if (persona !== null && agent !== null) rows.push({ persona, agent });
  }
  return rows;
}

/**
 * `{ persona display name -> agent slug }` from a Routing Matrix table.
 *
 * Deduplicates by persona (last row wins), so callers that care about a
 * duplicated persona row must use {@link routingMatrixRows} instead.
 */
export function routingMatrixPairs(text: string): Map<string, string> {
  return new Map(routingMatrixRows(text).map((row) => [row.persona, row.agent]));
}
