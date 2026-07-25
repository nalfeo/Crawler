import { trackAuthoringActivity } from '../../../../scripts/agent/sync-main.mjs';

// Never auto-rebase from a pre-tool hook: tool arguments are prepared against
// the current HEAD before check() runs, so rebasing here would leave the next
// mutating operation targeting a stale tree. Emit a reminder only; the agent
// must checkpoint and sync explicitly at a safe boundary (e.g. before a
// read-only exploration turn, or via `npm run sync:main -- --reason periodic`).
const REMINDER_SYNC = () => ({
  status: 'reminder-due',
  branchChanged: false,
  message: 'Run `npm run sync:main -- --reason periodic` to synchronize with main.',
});

export default {
  id: 'authoring-main-sync',
  category: 'authoring',
  failClosed: false,
  matches(toolName) {
    return toolName !== 'create_pull_request';
  },
  check(_toolArgs, ctx) {
    const result = trackAuthoringActivity({ cwd: ctx.cwd, runSync: REMINDER_SYNC });
    return {
      decision: 'allow',
      ...(result.warning ? { additionalContext: result.warning } : {}),
    };
  },
};
