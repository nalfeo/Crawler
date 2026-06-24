// edit-apple-metrics-write-only: block manual edit/create of apple metric files.
//
// Apple metrics are required to be generated via the dedicated writer CLI so
// canonical fields are always computed consistently.

const APPLE_FILE_RE = /^docs\/knowledge\/metrics\/apples\/[^/]+\.json$/;

function normalizePath(p) {
  return String(p || '').replace(/\\/g, '/');
}

export default {
  id: 'edit-apple-metrics-write-only',
  category: 'edit',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'edit' && toolName !== 'create') return false;
    const path = normalizePath(toolArgs?.path);
    return APPLE_FILE_RE.test(path);
  },
  check(toolArgs) {
    const path = normalizePath(toolArgs?.path);
    if (!APPLE_FILE_RE.test(path)) return { decision: 'allow' };
    return {
      decision: 'deny',
      reason:
        `Refusing manual ${path ? `write to '${path}'` : 'apple metrics write'}. ` +
        'Use the canonical tool: `npm run docs:apple:write -- --date YYYY-MM-DD --session <slug> --estimated <1-5> --actual <0-10>`.',
    };
  },
};

export { APPLE_FILE_RE, normalizePath };
