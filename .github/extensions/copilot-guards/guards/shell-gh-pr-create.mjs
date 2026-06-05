// shell-gh-pr-create: block `gh pr create` from shell.
//
// Rationale: PR-preflight guards run on `create_pull_request` (the
// native tool). Letting agents use `gh pr create` lets them bypass
// every PR check — handoff, semantic title, lab gate, etc.
//
// Tell the agent to use the structured tool instead.

import { isGh, normalizeCommand } from '../lib/shell.mjs';

function segmentDeniesGhPrCreate(seg) {
  if (!isGh(seg)) return null;
  if (/\bpr\b/.test(seg) && /\bcreate\b/.test(seg)) {
    return `Use the 'create_pull_request' tool instead of 'gh pr create' so PR-preflight guards (semantic title, handoff, lab gate, forbidden paths) can run. Segment: \`${seg}\`.`;
  }
  return null;
}

export default {
  id: 'shell-gh-pr-create',
  category: 'shell',
  failClosed: false,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell' && toolName !== 'bash') return false;
    const cmd = String(toolArgs?.command || '');
    return /\bgh\b/.test(cmd) && /\bpr\b/.test(cmd) && /\bcreate\b/.test(cmd);
  },
  check(toolArgs) {
    const cmd = String(toolArgs?.command || '');
    for (const seg of normalizeCommand(cmd)) {
      const reason = segmentDeniesGhPrCreate(seg);
      if (reason) return { decision: 'deny', reason };
    }
    return { decision: 'allow' };
  },
};
