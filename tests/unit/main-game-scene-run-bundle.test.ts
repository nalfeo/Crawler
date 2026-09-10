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
  ).replace(/\(error: unknown\)/g, '(error)')}};`,
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

const isTerminalRunSurveyActive = new Function(
  `return function canResetRunFromTerminalSurvey() {${extractMethodBody(
    source,
    'private isTerminalRunSurveyActive(): boolean',
  )}};`,
)() as (this: {
  runSurveyUI?: { isVisible: () => boolean };
  runSurveySubmitted: boolean;
}) => boolean;

const canResetRunFromTerminalSurvey = new Function(
  `return function canResetRunFromTerminalSurvey() {${extractMethodBody(
    source,
    'private canResetRunFromTerminalSurvey(): boolean',
  )}};`,
)() as (this: { isTerminalRunSurveyActive: () => boolean }) => boolean;

const flashActionStatus = new Function(
  `return function flashActionStatus(message) {${extractMethodBody(
    source,
    'private flashActionStatus(message: string): void',
  )}};`,
)() as (this: unknown, message: string) => void;

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

  it('reports a synchronous onRunBundle throw through the upload failure path', async () => {
    const { scene, onRunBundle } = makeSceneFixture();
    const error = new Error('sync hook exploded');
    onRunBundle.mockImplementationOnce(() => {
      throw error;
    });
    const reportRunBundleUploadResult = vi.fn();
    Object.assign(scene, { reportRunBundleUploadResult });

    expect(() => emitRunBundle.call(scene, 'victory')).not.toThrow();
    expect(onRunBundle).toHaveBeenCalledTimes(1);
    await expect(
      (scene as unknown as { lastRunBundleUpload?: Promise<unknown> }).lastRunBundleUpload,
    ).rejects.toThrow('sync hook exploded');
    await Promise.resolve();
    expect(reportRunBundleUploadResult).toHaveBeenCalledWith(undefined, error);
  });

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

  it('blocks terminal reset actions while the end-of-run survey is still open', () => {
    const scene = { isTerminalRunSurveyActive: () => true };
    expect(canResetRunFromTerminalSurvey.call(scene)).toBe(false);

    scene.isTerminalRunSurveyActive = () => false;
    expect(canResetRunFromTerminalSurvey.call(scene)).toBe(true);
  });

  it('keeps terminal reset actions available after the survey closes', () => {
    const visibleSurvey = {
      runSurveyUI: { isVisible: () => true },
      runSurveySubmitted: false,
    };
    expect(isTerminalRunSurveyActive.call(visibleSurvey)).toBe(true);

    const submittedSurvey = {
      runSurveyUI: { isVisible: () => true },
      runSurveySubmitted: true,
    };
    expect(isTerminalRunSurveyActive.call(submittedSurvey)).toBe(false);

    const hiddenSurvey = {
      runSurveyUI: { isVisible: () => false },
      runSurveySubmitted: false,
    };
    expect(isTerminalRunSurveyActive.call(hiddenSurvey)).toBe(false);
  });

  it('makes game-over restart and quit confirmation rejectable while the survey is active', () => {
    expect(source).toMatch(
      /onRestart: \(\) => \{[\s\S]*if \(!this\.canResetRunFromTerminalSurvey\(\)\) \{[\s\S]*return false;[\s\S]*window\.location\.reload\(\);[\s\S]*return true;[\s\S]*\},/,
    );
    expect(source).toMatch(
      /onQuit: \(\) => \{[\s\S]*if \(!this\.canResetRunFromTerminalSurvey\(\)\) \{[\s\S]*return false;[\s\S]*this\.emitRunBundle\('quit'\);[\s\S]*window\.location\.reload\(\);[\s\S]*return true;[\s\S]*\},/,
    );
  });
});

describe('MainGameScene action status toast', () => {
  it('does not let an older identical-message timer hide a newer display', () => {
    interface MockActionStatusText {
      text: string;
      visible: boolean;
      setText: (message: string) => MockActionStatusText;
      setVisible: (visible: boolean) => MockActionStatusText;
    }
    const callbacks: Array<() => void> = [];
    const actionStatusText: MockActionStatusText = {
      text: '',
      visible: false,
      setText(message: string) {
        this.text = message;
        return this;
      },
      setVisible(visible: boolean) {
        this.visible = visible;
        return this;
      },
    };
    const scene = {
      actionStatusText,
      actionStatusDisplayToken: 0,
      time: {
        delayedCall: vi.fn((_delayMs: number, callback: () => void) => {
          callbacks.push(callback);
        }),
      },
    };

    flashActionStatus.call(scene, 'Issue submission failed');
    flashActionStatus.call(scene, 'Issue submission failed');

    callbacks[0]?.();
    expect(actionStatusText.visible).toBe(true);

    callbacks[1]?.();
    expect(actionStatusText.visible).toBe(false);
  });
});
