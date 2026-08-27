/** Manual, JSON-only entrypoint for audited assets/queue deletion recovery. */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  QueueRepairError,
  SELECTIVE_RECOVERY_POLICY,
  runQueueRepair,
  type QueueRepairMode,
} from './queue-repair.js';
import { createDefaultQueueRepairDeps } from './queue-repair-runtime.js';

interface ParsedArgs {
  readonly repoRoot: string;
  readonly mode: QueueRepairMode;
  readonly expectedMainSha?: string;
  readonly expectedQueueSha?: string;
  readonly policy: string;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  let repoRoot = process.cwd();
  let mode: QueueRepairMode = 'audit';
  let expectedMainSha: string | undefined;
  let expectedQueueSha: string | undefined;
  let policy = SELECTIVE_RECOVERY_POLICY;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    const value = (): string => {
      const next = argv[++index];
      if (!next) throw new Error(`${arg} requires a value`);
      return next;
    };
    if (arg === '--repo-root') repoRoot = value();
    else if (arg === '--audit') mode = 'audit';
    else if (arg === '--apply') mode = 'apply';
    else if (arg === '--policy') policy = value();
    else if (arg === '--expect-main') expectedMainSha = value();
    else if (arg === '--expect-queue') expectedQueueSha = value();
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (mode === 'apply' && (!expectedMainSha || !expectedQueueSha)) {
    throw new Error(
      '--apply requires --expect-main and --expect-queue from the JSON emitted by a preceding --audit',
    );
  }
  return { repoRoot, mode, expectedMainSha, expectedQueueSha, policy };
}

export async function main(argv: readonly string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    const result = await runQueueRepair(
      args.repoRoot,
      createDefaultQueueRepairDeps(args.repoRoot),
      {
        mode: args.mode,
        policy: args.policy,
        expectedMainSha: args.expectedMainSha,
        expectedQueueSha: args.expectedQueueSha,
      },
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const kind = error instanceof QueueRepairError ? error.kind : 'usage';
    process.stderr.write(`queue-repair failed (${kind}): ${message}\n`);
    return kind === 'usage' ? 10 : 1;
  }
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedAsScript) void main(process.argv.slice(2)).then((code) => process.exit(code));
