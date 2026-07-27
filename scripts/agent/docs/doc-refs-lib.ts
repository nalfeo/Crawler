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
  for (const line of text.split('\n')) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match && match[1]) headings.add(match[1]);
  }
  return headings;
}

/** Body of a `## <name>` section, up to the next `##` heading, or `null`. */
export function sectionBody(text: string, name: string): string | null {
  const lines = text.split('\n');
  const heading = new RegExp(`^##\\s+${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^##\s+/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

/** Every distinct `<name>.agent.md` referenced in a chunk of Markdown, in order. */
export function referencedAgents(text: string): string[] {
  const found: string[] = [];
  const re = /([a-z0-9-]+\.agent\.md)/g;
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
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return null;
  const block = text.slice(3, end);
  const match = /^description:\s*(.+)$/m.exec(block);
  if (!match || !match[1]) return null;
  const value = match[1].trim().replace(/^['"]|['"]$/g, '');
  return value.length > 0 ? value : null;
}
