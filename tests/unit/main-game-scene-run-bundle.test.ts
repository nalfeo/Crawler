import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import { createLogCursor, readLogsSince } from '../../src/shared/logger.js';
import { validatePlaytestSurvey } from '../../src/shared/playtest-survey.js';
import { createTestWorld } from '../helpers/world-factory.js';
import type { RunEndReason } from '../../src/shared/run-bundle.js';

const source = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf-8');

function extractMethodBody(sourceText: string, signature: string): string {
  const signatureIndex = sourceText.indexOf(signature);
  if (signatureIndex < 0) {
    throw new Error(`Could not find method signature: ${signature}`);
  }
  const openBrace = sourceText.indexOf('{', signatureIndex);
  if (openBrace < 0) {
    throw new Error(`Could not find method body start for: ${signature}`);
  }
  let depth = 1;
  for (let i = openBrace + 1; i < sourceText.length; i += 1) {
    const char = sourceText[i];
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      return sourceText.slice(openBrace + 1, i);
    }
  }
  throw new Error(`Unbalanced braces while parsing: ${signature}`);
}

const emitRunBundle = new Function(
  'createRunBundle',
  'readLogsSince',
  `return function emitRunBundle(endReason) {${extractMethodBody(
    source,
    'private emitRunBundle(endReason: RunEndReason): void',
  )}};`,
)(createRunBundle, readLogsSince) as (this: unknown, endReason: RunEndReason) => void;

const showRunSurveyIfNeeded = new Function(
  'createRunSurveyUI',
  'validatePlaytestSurvey',
  'submitRunSurvey',
  `return function showRunSurveyIfNeeded(endReason) {${extractMethodBody(
    source,
    "private showRunSurveyIfNeeded(endReason: 'death' | 'victory'): void",
  )
    .replace(/\(error: unknown\)/g, '(error)')
    .replace(/'fetch' as const/g, "'fetch'")}};`,
) as (
  createRunSurveyUI: (options: unknown) => { show: () => void },
  validatePlaytestSurvey: typeof import('../../src/shared/playtest-survey.js').validatePlaytestSurvey,
  submitRunSurvey: (
    bundle: unknown,
    survey: unknown,
  ) => Promise<{ ok: boolean; used: 'fetch'; status?: number }>,
) => (this: unknown, endReason: 'death' | 'victory') => void;

function makeSceneFixture() {
  const world = createTestWorld({ seed: 7 });
  const runStatsFactory = vi.fn().mockReturnValue({ outcome: 'quit' });
  const onRunBundle = vi.fn();
  const scene = {
    runBundleEmitted: false,
    options: {
      floorId: 'floor1',
      runStatsFactory,
      onRunBundle,
    },
    world,
    playerEid: 0,
    runStartXp: 0,
    runLogCursor: createLogCursor(),
    sessionRecorder: {
      getStats: () => ({
        totalEvents: 0,
        totalSamples: 0,
        totalKills: 0,
        durationMs: 0,
        controller: 'MANUAL' as const,
      }),
      toJsonl: () => '',
    },
    nextRunBundleId: () => 'test-run-id',
  };
  return { scene, runStatsFactory, onRunBundle, world };
}

describe('MainGameScene terminal run bundle emission', () => {
  it.each([
    ['death', 'death'],
    ['victory', 'victory'],
    ['timeout', 'timeout'],
    ['quit', 'quit'],
  ] as const)(
    'maps %s to runStats outcome %s, emits onRunBundle immediately, and only emits once',
    (endReason, expectedOutcome) => {
      const { scene, runStatsFactory, onRunBundle, world } = makeSceneFixture();
      emitRunBundle.call(scene, endReason);
      expect(onRunBundle).toHaveBeenCalledTimes(1);
      expect(runStatsFactory).toHaveBeenCalledWith(world, 0, expectedOutcome, 0, {
        totalEvents: 0,
        totalSamples: 0,
        totalKills: 0,
        durationMs: 0,
        controller: 'MANUAL',
      });
      expect(onRunBundle.mock.calls[0]?.[0]?.meta?.endReason).toBe(endReason);
      expect(
        (scene as unknown as { lastRunBundleUpload?: Promise<unknown> }).lastRunBundleUpload,
      ).toBeInstanceOf(Promise);

      emitRunBundle.call(scene, 'quit');
      expect(onRunBundle).toHaveBeenCalledTimes(1);
    },
  );

  it('waits for the completion upload before appending survey feedback', async () => {
    let submitSurvey: ((survey: unknown) => Promise<boolean>) | undefined;
    let skipSurvey: (() => void) | undefined;
    const createRunSurveyUI = vi.fn((options: unknown) => {
      const surveyOptions = options as { onSubmit: typeof submitSurvey; onSkip: () => void };
      submitSurvey = surveyOptions.onSubmit;
      skipSurvey = surveyOptions.onSkip;
      return { show: vi.fn() };
    });
    const submitRunSurvey = vi.fn(async () => ({ ok: true, used: 'fetch' as const, status: 201 }));
    let resolveUpload: (() => void) | undefined;
    const scene = {
      runSurveyShown: false,
      runSurveySubmitted: false,
      lastRunBundle: createRunBundle({
        runStats: { outcome: 'victory' },
        meta: { endReason: 'victory', runId: 'survey-run-id' },
      }),
      lastRunBundleUpload: new Promise<void>((resolve) => {
        resolveUpload = resolve;
      }),
      options: { onRunBundle: vi.fn() },
    };

    showRunSurveyIfNeeded(createRunSurveyUI, validatePlaytestSurvey, submitRunSurvey).call(
      scene,
      'victory',
    );

    expect(submitSurvey).toBeDefined();
    expect(skipSurvey).toBeDefined();
    const submitPromise = submitSurvey?.({
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 5,
      tension: 2,
    });
    await Promise.resolve();
    expect(submitRunSurvey).not.toHaveBeenCalled();

    resolveUpload?.();
    await expect(submitPromise).resolves.toBe(true);
    expect(submitRunSurvey).toHaveBeenCalledWith(scene.lastRunBundle, {
      enjoyment: 5,
      immersion: 4,
      mastery: 3,
      control: 5,
      tension: 2,
    });

    skipSurvey?.();
    expect(scene.options.onRunBundle).not.toHaveBeenCalled();
  });

  it('emits terminal bundle before scene restart on floor transition', () => {
    expect(source).toMatch(
      /this\.emitRunBundle\(completionVariant === 'failed_timeout' \? 'timeout' : 'victory'\);[\s\S]*this\.scene\.restart\(\{ mainGameSceneOptions: composedNextOptions \}\);/,
    );
  });

  it('emits quit bundle before browser reload in the quit callback path', () => {
    expect(source).toMatch(
      /onQuit: \(\) => \{[\s\S]*this\.emitRunBundle\('quit'\);[\s\S]*window\.location\.reload\(\);[\s\S]*\},/,
    );
  });
});
