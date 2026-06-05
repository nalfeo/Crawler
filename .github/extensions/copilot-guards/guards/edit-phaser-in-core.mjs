// edit-phaser-in-core: block adding `from 'phaser'` (or similar) inside
// src/core/**. The bridge pattern keeps core portable.
//
// ESLint also catches this, but ESLint runs after the edit lands.
// Catching it pre-tool means the agent gets immediate feedback and
// doesn't accidentally invest in a path that the lint gate will reject.

import { stripCommentsOnly } from '../lib/strip-comments.mjs';

const PHASER_IMPORT_RE =
  /(?:from\s+['"]phaser['"]|require\s*\(\s*['"]phaser['"]\s*\)|import\s*\(\s*['"]phaser['"]\s*\))/;

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

function shouldCheck(path) {
  if (!path) return false;
  return /^src[\\/]core[\\/]/.test(path);
}

export default {
  id: 'edit-phaser-in-core',
  category: 'edit',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'edit' && toolName !== 'create') return false;
    return shouldCheck(normalizePath(toolArgs?.path));
  },
  check(toolArgs) {
    const path = normalizePath(toolArgs?.path);
    const candidate = String(toolArgs?.new_str ?? toolArgs?.file_text ?? '');
    const stripped = stripCommentsOnly(candidate);
    if (!PHASER_IMPORT_RE.test(stripped)) return { decision: 'allow' };
    return {
      decision: 'deny',
      reason: `${path} imports from 'phaser'. src/core/** must stay rendering-free. Put Phaser-touching code in src/engine/** and call into it via a bridge interface defined in src/shared/**.`,
    };
  },
};

export { PHASER_IMPORT_RE, shouldCheck, normalizePath };
