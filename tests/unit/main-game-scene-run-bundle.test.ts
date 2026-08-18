import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRunBundle } from '../../src/shared/run-bundle.js';
import { createLogCursor, readLogsSince } from '../../src/shared/logger.js';
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

      emitRunBundle.call(scene, 'quit');
      expect(onRunBundle).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['death', 'death'],
    ['victory', 'victory'],
  ] as const)(
    'maps %s to runStats outcome %s but defers onRunBundle to the survey skip/submit path',
    (endReason, expectedOutcome) => {
      const { scene, runStatsFactory, onRunBundle, world } = makeSceneFixture();
      emitRunBundle.call(scene, endReason);
      // A survey opportunity may follow death/victory: emitRunBundle must not
      // upload immediately, otherwise a later survey submission would resend
      // the run under an unrelated stored ID (see PR #2952 review).
      expect(onRunBundle).not.toHaveBeenCalled();
      expect(runStatsFactory).toHaveBeenCalledWith(world, 0, expectedOutcome, 0, {
        totalEvents: 0,
        totalSamples: 0,
        totalKills: 0,
        durationMs: 0,
        controller: 'MANUAL',
      });
      expect(
        (scene as unknown as { lastRunBundle?: { meta?: { endReason?: string } } }).lastRunBundle
          ?.meta?.endReason,
      ).toBe(endReason);

      // Mirrors what showRunSurveyIfNeeded's onSkip does: the deferred bundle
      // is still uploadable exactly once via the same onRunBundle sink.
      onRunBundle((scene as unknown as { lastRunBundle: unknown }).lastRunBundle);
      expect(onRunBundle).toHaveBeenCalledTimes(1);
    },
  );

  it('emits terminal bundle before scene restart on floor transition', () => {
    expect(source).toMatch(
      /this\.emitRunBundle\(completionPresentation === 'failed_timeout' \? 'timeout' : 'victory'\);[\s\S]*this\.scene\.restart\(\{ mainGameSceneOptions: composedNextOptions \}\);/,
    );
  });

  it('emits quit bundle before browser reload in the quit callback path', () => {
    expect(source).toMatch(
      /onQuit: \(\) => \{[\s\S]*this\.emitRunBundle\('quit'\);[\s\S]*window\.location\.reload\(\);[\s\S]*\},/,
    );
  });
});
