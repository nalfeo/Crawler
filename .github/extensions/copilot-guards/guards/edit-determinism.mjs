// edit-determinism: block Math.random()/Date.now()/performance.now()
// added in deterministic gameplay layers (src/core, src/game, src/shared).
//
// Excludes:
//   - src/labs/**   (sandbox; uses real wall clock for dev tooling)
//   - tests/**      (tests can use Math.random for fixtures)
//   - **/*.test.ts, **/*.spec.ts (same reason)
//   - **/*.d.ts
//   - any string / comment occurrences (stripped before matching)
//
// Pointer to fix is included in deny message.

import { stripCommentsAndStrings } from '../lib/strip-comments.mjs';

const GUARDED_PATH_RE = /^src[\\/](?:core|game|shared)[\\/]/;
const EXCLUDED_PATH_RE =
  /(?:[\\/]tests?[\\/]|\.test\.[mc]?[jt]sx?$|\.spec\.[mc]?[jt]sx?$|\.d\.ts$)/;

const FORBIDDEN = [
  {
    pattern: /\bMath\.random\s*\(/,
    name: 'Math.random()',
    hint: 'Use SeededRandom from src/shared/random.ts (e.g. `world.rng.next()`).',
  },
  {
    pattern: /\bDate\.now\s*\(/,
    name: 'Date.now()',
    hint: 'Pass delta / frameCount as a parameter; never read wall-clock time in deterministic gameplay code.',
  },
  {
    pattern: /\bperformance\.now\s*\(/,
    name: 'performance.now()',
    hint: 'Pass delta / frameCount as a parameter; never read wall-clock time in deterministic gameplay code.',
  },
];

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function shouldCheck(path) {
  if (!path) return false;
  if (EXCLUDED_PATH_RE.test(path)) return false;
  return GUARDED_PATH_RE.test(path);
}

function findViolations(text) {
  const stripped = stripCommentsAndStrings(text);
  const hits = [];
  for (const f of FORBIDDEN) {
    if (f.pattern.test(stripped)) hits.push(f);
  }
  return hits;
}

export default {
  id: 'edit-determinism',
  category: 'edit',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'edit' && toolName !== 'create') return false;
    const path = normalizePath(toolArgs?.path);
    return shouldCheck(path);
  },
  check(toolArgs) {
    const path = normalizePath(toolArgs?.path);
    const candidate = toolArgs?.new_str ?? toolArgs?.file_text ?? '';
    const hits = findViolations(String(candidate));
    if (hits.length === 0) return { decision: 'allow' };
    const names = hits.map((h) => h.name).join(', ');
    const hints = hits.map((h) => `  • ${h.name} → ${h.hint}`).join('\n');
    return {
      decision: 'deny',
      reason: `${path} introduces non-deterministic call(s): ${names}.\n${hints}\n\nGuarded paths: src/core/**, src/game/**, src/shared/**. Tests and src/labs/** are exempt.`,
    };
  },
};

export { findViolations, shouldCheck, normalizePath };
