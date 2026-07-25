import { trackAuthoringActivity } from '../../../../scripts/agent/sync-main.mjs';

export default {
  id: 'authoring-main-sync',
  category: 'authoring',
  failClosed: false,
  matches(toolName) {
    return toolName !== 'create_pull_request';
  },
  check(_toolArgs, ctx) {
    const result = trackAuthoringActivity({ cwd: ctx.cwd });
    return {
      decision: 'allow',
      ...(result.warning ? { additionalContext: result.warning } : {}),
    };
  },
};
