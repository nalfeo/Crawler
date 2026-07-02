/**
 * commitlint config for PR *title* validation (the `commit-lint` CI workflow).
 *
 * PRs squash-merge, so the PR title — not the intermediate commit subjects —
 * becomes the commit on `main`. We reuse the base type/length rules but drop the
 * base `ignores`, which exist purely for commit *history* artifacts:
 *   - GitHub auto-merge "Title (#123)" subjects,
 *   - "merge:" / rebase-reconciliation metadata,
 *   - a handful of exact historical subjects.
 * Applying those to a user-controlled PR title would let a malformed title such
 * as `bad title (#12)` slip through the gate, so this config enforces the
 * conventional format with no escape hatches.
 */
const base = require('./commitlint.config.cjs');

module.exports = {
  ...base,
  ignores: [],
};
