/** Deterministic, budgeted lookup over the generated handoff index. */

export const DEFAULT_OUTPUT_BUDGET = 2_000;
const HANDOFF_ROOT = 'docs/knowledge/handoffs';

function tokens(value) {
  return value.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function compact(value, max) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}

/** Parse the stable per-system bullets emitted by build-system-index.ts. */
export function parseIndex(index) {
  const entries = [];
  let system = '';
  for (const line of index.split(/\r?\n/)) {
    const heading = /^##\s+([a-z0-9][a-z0-9-]*)\s*$/.exec(line);
    if (heading) {
      system = heading[1];
      continue;
    }
    const bullet = /^-\s+\[(\d{4}-\d{2}-\d{2})-([^\]]+)\]\(([^)]+)\)\s+—\s+(.+)$/.exec(line);
    if (bullet && system) {
      entries.push({
        date: bullet[1],
        path: `${HANDOFF_ROOT}/${bullet[3]}`,
        system,
        summary: compact(bullet[4], 240),
      });
    }
  }
  return entries;
}

function score(entry, query) {
  const system = entry.system.toLowerCase();
  const path = entry.path.toLowerCase();
  const summary = entry.summary.toLowerCase();
  const exactSystem = system === query.join('-') || system === query.join('');
  let result = exactSystem ? 1_000 : 0;
  for (const token of query) {
    if (system.split('-').includes(token)) result += 100;
    if (path.includes(token)) result += 25;
    if (summary.includes(token)) result += 10;
  }
  return result;
}

export function retrieveHandoffs(index, query, contents) {
  const queryTokens = tokens(query);
  if (queryTokens.length === 0) return [];
  const deduped = new Map();
  for (const entry of parseIndex(index)) {
    const entryScore = score(entry, queryTokens);
    if (entryScore === 0) continue;
    const body = contents.get(entry.path) ?? '';
    const candidate = { ...entry, score: entryScore, excerpt: compact(body || entry.summary, 280) };
    const prior = deduped.get(entry.path);
    if (!prior || candidate.score > prior.score) deduped.set(entry.path, candidate);
  }
  return [...deduped.values()].sort(
    (a, b) =>
      b.score - a.score ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      a.path.localeCompare(b.path),
  );
}

function fallback(query) {
  return `No relevant handoff found for ${JSON.stringify(query)}. Narrow fallback: rg -n -i --glob '*.md' ${JSON.stringify(query)} ${HANDOFF_ROOT}`;
}

/** Render only whole entries and never exceed the requested (max 2,000) budget. */
export function renderHandoffResults(query, results, budget = DEFAULT_OUTPUT_BUDGET) {
  const cap = Math.min(Math.max(1, budget), DEFAULT_OUTPUT_BUDGET);
  const noMatch = fallback(query);
  if (results.length === 0) return compact(noMatch, cap);
  let output = `Relevant handoffs for ${JSON.stringify(query)} (max ${cap} chars):\n`;
  if (output.length > cap) return compact(output, cap);
  for (const result of results) {
    const block = `\n- ${result.path} | ${result.system} | ${result.date}\n  ${result.summary}\n  Excerpt: ${result.excerpt}\n`;
    if (output.length + block.length > cap) break;
    output += block;
  }
  return output.trimEnd();
}
