import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiSweepDispatchArgs,
  parseWeapons,
  selectDispatchedRun,
  viewerReference,
  weaponSweepDispatchArgs,
} from '../lib/runner.mjs';

test('builds canonical weapon sweep dispatch args without shell interpolation', () => {
  assert.deepEqual(weaponSweepDispatchArgs({ ref: 'feature/test', seedCount: 100 }), [
    'workflow',
    'run',
    'weapon-sweep.yml',
    '--ref',
    'feature/test',
    '-f',
    'seed_count=100',
    '-f',
    'weapons=sword,bow,baseball-bat',
    '-f',
    'weapon_personas=true',
    '-f',
    'max_frames=19800',
  ]);
});

test('builds AI sweep dispatch args with bounded resume metadata', () => {
  const args = aiSweepDispatchArgs({
    ref: 'main',
    combos: 'riskRewardFused+legacy',
    trainSeeds: '1-80',
    validateSeeds: '1-100',
    rounds: 3,
    resumeRunId: 123,
  });
  assert.ok(args.includes('ai-sweep.yml'));
  assert.ok(args.includes('combos=riskRewardFused+legacy'));
  assert.ok(args.includes('train_seeds=1-80'));
  assert.ok(args.includes('validate_seeds=1-100'));
  assert.ok(args.includes('rounds=3'));
  assert.ok(args.includes('resume_run_id=123'));
});

test('validates weapons, refs, and ranges before dispatch', () => {
  assert.deepEqual(parseWeapons('sword,bow'), ['sword', 'bow']);
  assert.throws(() => parseWeapons('sword,sword'), /Duplicate weapon/);
  assert.throws(() => parseWeapons('sword,../bad'), /Unsupported weapon/);
  assert.throws(() => weaponSweepDispatchArgs({ ref: '../main' }), /ref must be a safe/);
  assert.throws(() => weaponSweepDispatchArgs({ seedCount: 101 }), /seedCount/);
  assert.throws(() => aiSweepDispatchArgs({ trainSeeds: '1; rm -rf' }), /trainSeeds/);
  assert.throws(
    () => aiSweepDispatchArgs({ combos: 'riskRewardFused+legacy;bad' }),
    /Unsafe combo/,
  );
});

test('viewer reference uses the required app-native runId format', () => {
  assert.equal(viewerReference(12345), 'project:sweep-results-viewer runId=12345');
});

test('selects a dispatched run only when exactly one new run appears', () => {
  const before = [{ id: 10 }, { id: 9 }];
  assert.deepEqual(selectDispatchedRun(before, [{ id: 11 }, { id: 10 }, { id: 9 }]), { id: 11 });
  assert.equal(selectDispatchedRun(before, [{ id: 12 }, { id: 11 }, { id: 10 }]), null);
  assert.equal(selectDispatchedRun(before, before), null);
});
