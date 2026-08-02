// Extension: copilot-guards
// Deterministic pre-tool-use guards enforcing Crawler project conventions.
// See ./README.md for the list of guards and how to bypass them.

import { joinSession } from '@github/copilot-sdk/extension';
import { dispatch } from './lib/dispatcher.mjs';

import shellForcePushMain from './guards/shell-force-push-main.mjs';
import shellMainBranchDelete from './guards/shell-main-branch-delete.mjs';
import shellBluntMergeStrategy from './guards/shell-blunt-merge-strategy.mjs';
import shellGhPrCreate from './guards/shell-gh-pr-create.mjs';
import shellRmRfRepo from './guards/shell-rm-rf-repo.mjs';
import shellUnsafePortKill from './guards/shell-unsafe-port-kill.mjs';
import authoringMainSync from './guards/authoring-main-sync.mjs';
import editDeterminism from './guards/edit-determinism.mjs';
import editPhaserInCore from './guards/edit-phaser-in-core.mjs';
import editRepoMdJunk from './guards/edit-repo-md-junk.mjs';
import editGuardSelfProtection from './guards/edit-guard-self-protection.mjs';
import prPreflight from './guards/pr-preflight.mjs';
import prReviewLedger from './guards/pr-review-ledger.mjs';

// Order matters: shell/edit guards first (cheap), PR aggregator last
// (it shells out to git and bash).
const guards = [
  shellForcePushMain,
  shellMainBranchDelete,
  shellBluntMergeStrategy,
  shellGhPrCreate,
  shellRmRfRepo,
  shellUnsafePortKill,
  authoringMainSync,
  editDeterminism,
  editPhaserInCore,
  editRepoMdJunk,
  editGuardSelfProtection,
  prPreflight,
  prReviewLedger,
];

const session = await joinSession({
  hooks: {
    onSessionStart: async () => {
      await session.log(
        `copilot-guards loaded: ${guards.length} guards active. Bypass with COPILOT_GUARDS_DISABLE=<id>[,id...] or '*'.`,
      );
    },
    onPreToolUse: async (input) => {
      const ctx = {
        cwd: input.workingDirectory || process.cwd(),
        log: (msg, opts) => session.log(msg, opts),
      };
      return await dispatch(guards, input.toolName, input.toolArgs, ctx);
    },
  },
});
