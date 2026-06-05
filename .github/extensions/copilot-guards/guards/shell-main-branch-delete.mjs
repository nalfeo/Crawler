// shell-main-branch-delete: block deletion of the main/master branch
// via git push --delete, git branch -D, or refspec-style deletion.

import { isGit, normalizeCommand } from '../lib/shell.mjs';

const PROTECTED_BRANCHES = ['main', 'master'];

function segmentDeniesMainDelete(seg) {
  if (!isGit(seg)) return null;

  // `git push origin --delete main` / `git push origin -d main`
  if (/\bpush\b/.test(seg) && /(--delete|\s-d\b)/.test(seg)) {
    if (PROTECTED_BRANCHES.some((b) => new RegExp(`\\b${b}\\b`).test(seg))) {
      return `Refusing to delete a protected branch (main/master) via 'git push --delete'. Segment: \`${seg}\`.`;
    }
  }
  // Refspec delete form: `git push origin :main`
  if (/\bpush\b/.test(seg)) {
    if (PROTECTED_BRANCHES.some((b) => new RegExp(`\\s:${b}(\\s|$)`).test(seg))) {
      return `Refusing to delete a protected branch (main/master) via refspec ':main' form. Segment: \`${seg}\`.`;
    }
  }
  // Local: `git branch -d main` / `-D main`
  if (/\bbranch\b/.test(seg) && /\s-[dD]\b/.test(seg)) {
    if (PROTECTED_BRANCHES.some((b) => new RegExp(`\\b${b}\\b`).test(seg))) {
      return `Refusing to delete a protected branch (main/master) locally. Segment: \`${seg}\`.`;
    }
  }
  return null;
}

export default {
  id: 'shell-main-branch-delete',
  category: 'shell',
  failClosed: true,
  matches(toolName, toolArgs) {
    if (toolName !== 'powershell' && toolName !== 'bash') return false;
    const cmd = String(toolArgs?.command || '');
    return /\b(main|master)\b/.test(cmd) && /(delete|-d\b|-D\b|:main|:master)/.test(cmd);
  },
  check(toolArgs) {
    const cmd = String(toolArgs?.command || '');
    for (const seg of normalizeCommand(cmd)) {
      const reason = segmentDeniesMainDelete(seg);
      if (reason) return { decision: 'deny', reason };
    }
    return { decision: 'allow' };
  },
};
