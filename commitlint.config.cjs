/**
 * Conventional Commits, with the extra scopes/types used by the Crawler
 * automation rules (`docs:`, `lab:` already-existed; `chore:` and `fix:` too).
 */
module.exports = {
  extends: ['@commitlint/config-conventional'],
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
