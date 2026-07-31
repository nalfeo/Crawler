#!/usr/bin/env node

import path from 'node:path';
import process from 'node:process';
import { canAdvanceThemeSet, type ThemeEquipmentSetState } from './theme-equipment-set.js';
import {
  createThemeEquipmentRunnerDeps,
  ThemeEquipmentRunner,
  ThemeEquipmentSetPhasePartialError,
} from './theme-equipment-runner.js';

export type ThemeEquipmentCliAction = 'init' | 'run-phase' | 'advance' | 'status' | 'publish';

export interface ThemeEquipmentCliArgs {
  readonly action: ThemeEquipmentCliAction;
  readonly setId?: string;
  readonly planPath?: string;
}

export function parseArgs(argv: readonly string[]): ThemeEquipmentCliArgs {
  const [action, ...rest] = argv;
  if (!isAction(action)) {
    throw new Error(
      `Expected action init|run-phase|advance|status|publish, got "${action ?? ''}".`,
    );
  }
  let setId: string | undefined;
  let planPath: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--set-id') {
      setId = requiredValue(rest[++i], '--set-id');
    } else if (arg === '--plan') {
      planPath = requiredValue(rest[++i], '--plan');
    } else {
      throw new Error(`Unknown argument "${arg}".`);
    }
  }
  if (action === 'init') {
    if (!planPath) throw new Error('init requires --plan <path>.');
    if (setId) throw new Error('init derives the set id from the authored plan; omit --set-id.');
  } else if (!setId) {
    throw new Error(`${action} requires --set-id <id>.`);
  }
  return { action, ...(setId ? { setId } : {}), ...(planPath ? { planPath } : {}) };
}

export function sanitizeStatus(state: ThemeEquipmentSetState): Record<string, unknown> {
  const advance = canAdvanceThemeSet(state);
  return {
    id: state.id,
    displayName: state.displayName,
    phase: state.phase,
    stateRevision: state.stateRevision,
    publication: state.publication,
    canAdvance: advance.canAdvance,
    advanceTo: advance.toPhase,
    gateReasons: advance.reasons,
    phases: Object.fromEntries(
      Object.entries(state.phases).map(([phase, record]) => [
        phase,
        {
          humanReview: record.humanReview.verdict,
          collectionJudge: record.collectionJudge
            ? { score: record.collectionJudge.score, provenance: record.collectionJudge.provenance }
            : null,
        },
      ]),
    ),
    items: state.items.map((item) => ({
      id: item.id,
      revision: item.revision,
      revisionStatus: item.revisionStatus,
      phases: Object.fromEntries(
        Object.entries(item.phases).map(([phase, record]) => [
          phase,
          {
            review: record.review.verdict,
            generationError: record.generationError ? record.generationError.message : null,
            artifacts: record.artifacts.map(({ id, kind, briefId, runId, variantIndex }) => ({
              id,
              kind,
              ...(briefId ? { briefId } : {}),
              ...(runId ? { runId } : {}),
              ...(variantIndex !== undefined ? { variantIndex } : {}),
            })),
          },
        ]),
      ),
    })),
  };
}

export async function main(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args: ThemeEquipmentCliArgs;
  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }

  try {
    const root = path.resolve(cwd);
    const mode = args.action === 'init' || args.action === 'run-phase' ? 'full' : 'state-only';
    const runner = new ThemeEquipmentRunner(
      createThemeEquipmentRunnerDeps(root, env, undefined, mode),
    );
    const state =
      args.action === 'init'
        ? await runner.init(args.planPath!)
        : args.action === 'run-phase'
          ? await runner.runPhase(args.setId!)
          : args.action === 'advance'
            ? await runner.advance(args.setId!)
            : args.action === 'publish'
              ? await runner.publish(args.setId!)
              : await runner.status(args.setId!);
    process.stdout.write(`${JSON.stringify(sanitizeStatus(state), null, 2)}\n`);
    return 0;
  } catch (error) {
    // A partial phase pass DID checkpoint the accepted work: emit the sanitized
    // persisted state on stdout (so the driver/canvas sees exactly what
    // survived, including per-item generationError markers) and the actionable
    // re-run guidance on stderr, then exit non-zero to signal "not fully done".
    if (error instanceof ThemeEquipmentSetPhasePartialError) {
      process.stdout.write(`${JSON.stringify(sanitizeStatus(error.state), null, 2)}\n`);
      process.stderr.write(
        `theme-equipment ${args.action} partially completed: ${error.message}\n`,
      );
      return 1;
    }
    process.stderr.write(
      `theme-equipment ${args.action} failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

function isAction(value: string | undefined): value is ThemeEquipmentCliAction {
  return (
    value === 'init' ||
    value === 'run-phase' ||
    value === 'advance' ||
    value === 'status' ||
    value === 'publish'
  );
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value.`);
  return value;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisPath = path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invokedPath === thisPath) {
  void main(process.argv.slice(2), process.cwd()).then((code) => process.exit(code));
}
