/**
 * Unit tests for the sprites:run `--model` allowlist.
 *
 * Regression guard for the baseline-deployment gap: `--model` writes directly
 * into `AZURE_OPENAI_IMAGE_DEPLOYMENT`, so an allowlist that omits the factory
 * default (`DEFAULT_AZURE_DEPLOYMENT`, provider/factory.ts) makes the flag
 * strictly more restrictive than the env var it overrides — the baseline /
 * only-tested deployment could not be selected or benchmarked against the
 * others. These tests fail if the baseline ever drops out of the allowlist.
 */

import { describe, expect, it } from 'vitest';
import { SUPPORTED_IMAGE_MODELS, parseArgs } from '../../../scripts/sprites/cli.js';
import { DEFAULT_AZURE_DEPLOYMENT } from '../../../scripts/sprites/provider/factory.js';

const SAMPLE_BRIEF = 'briefs/weapons/iron-sword.yaml';

describe('sprites:run --model allowlist', () => {
  it('includes the factory baseline deployment so it stays selectable', () => {
    expect(SUPPORTED_IMAGE_MODELS).toContain(DEFAULT_AZURE_DEPLOYMENT);
  });

  it('accepts --model set to the baseline deployment', () => {
    const args = parseArgs(['--brief', SAMPLE_BRIEF, '--model', DEFAULT_AZURE_DEPLOYMENT]);
    expect(args.model).toBe(DEFAULT_AZURE_DEPLOYMENT);
  });

  it('accepts every officially-supported model', () => {
    for (const model of SUPPORTED_IMAGE_MODELS) {
      const args = parseArgs(['--brief', SAMPLE_BRIEF, '--model', model]);
      expect(args.model).toBe(model);
    }
  });

  it('leaves model undefined when --model is omitted', () => {
    expect(parseArgs(['--brief', SAMPLE_BRIEF]).model).toBeUndefined();
  });

  it('still rejects an unsupported model (validating allowlist, not weakened)', () => {
    expect(() => parseArgs(['--brief', SAMPLE_BRIEF, '--model', 'not-a-real-model'])).toThrow(
      /not supported/,
    );
  });

  it('rejects a missing value for --model', () => {
    expect(() => parseArgs(['--brief', SAMPLE_BRIEF, '--model'])).toThrow(
      /--model requires a model name/,
    );
  });
});
