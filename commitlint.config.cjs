/**
 * Conventional Commits, with the extra scopes/types used by the Crawler
 * automation rules (`docs:`, `lab:` already-existed; `chore:` and `fix:` too).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
  ignores: [
    /**
     * Agent-merge branch sync commits are generated as "merge: ...".
     * Treat these as merge metadata, not user-authored conventional commits.
     */
    (message) => message.toLowerCase().startsWith('merge:'),
    /**
     * Copilot cloud sessions can emit these transient subjects when recovering
     * partial edits; allow only these exact messages to keep policy strict.
     */
    (message) =>
      message.startsWith('Apply remaining changes') ||
      message.startsWith('Changes before error encountered'),
    /**
     * GitHub auto-merge commits have format "Title (#number)".
     * These are merge metadata, not conventional commits.
     */
    (message) => /^.+\s+\(#\d+\)$/.test(message.split('\n')[0]),
    /**
     * Historical rebase-reconciliation merge subject emitted by earlier agent
     * workflow recovery. Treat it as merge metadata so old PR history still
     * passes the repo's commitlint gate.
     */
    (message) => message.startsWith('Merge rebased commits (keep local rebase history)'),
  ],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'chore', 'docs', 'lab', 'refactor', 'test', 'perf', 'ci', 'build', 'revert'],
    ],
    'subject-case': [0],
    'body-max-line-length': [0],
    'footer-max-line-length': [0],
  },
};
