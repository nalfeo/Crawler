export interface ActionRequiredRun {
  id: number;
  conclusion: string | null;
  event: string | null;
  path: string | null;
  head_sha: string | null;
}

export interface ActionRequiredPull {
  number: number;
  state: string;
  base?: { ref?: string | null };
  head: {
    ref: string;
    sha: string;
    repo?: { full_name?: string | null };
  };
}

export type ParkedRunClassification =
  | null
  | 'run-not-action-required'
  | 'workflow-not-required'
  | 'pr-not-open'
  | 'fork'
  | 'head-moved'
  | 'latest-run-missing'
  | 'stale-run'
  | `event=${string}`;

export function classifyParkedRun(args: {
  run: ActionRequiredRun;
  pull: ActionRequiredPull | null;
  latestRun: ActionRequiredRun | null;
  repository?: string;
}): ParkedRunClassification;

export function pushEmptyCommit(
  pull: ActionRequiredPull,
  options?: {
    owner?: string;
    repo?: string;
    retriggerPat?: string;
    git?: (args: string[], options?: unknown) => string;
  },
): 'pushed' | 'lease-miss';
