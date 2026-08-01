import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import type { SweepConfig } from './gen-configs.js';

export const ISOLATED_SWEEP_RESULT_MARKER = 'ISOLATED_SWEEP_RESULT=';

interface IsolatedSweepPayload {
  config: SweepConfig;
  seed: number;
  weapon: string;
  maxFrames: number;
  wallCapMs: number;
  floorId: string;
  recordXpCollection: boolean;
}

const payloadFlag = process.argv.indexOf('--payload');
const encodedPayload = payloadFlag < 0 ? undefined : process.argv[payloadFlag + 1];
if (!encodedPayload) {
  throw new Error('--payload is required');
}

const payload = JSON.parse(
  Buffer.from(encodedPayload, 'base64url').toString('utf8'),
) as IsolatedSweepPayload;
const stats = await runHeadless(new BehaviorTreeAI({ ...payload.config, seed: payload.seed }), {
  seed: payload.seed,
  maxFrames: payload.maxFrames,
  maxWallTimeMs: payload.wallCapMs,
  forceWeaponId: payload.weapon,
  floorId: payload.floorId,
  recordXpCollection: payload.recordXpCollection,
});

console.log(`${ISOLATED_SWEEP_RESULT_MARKER}${JSON.stringify(stats)}`);
