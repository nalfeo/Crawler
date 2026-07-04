import { describe, expect, it } from 'vitest';
import { isCiEnv, isCiPipelineBypassed } from '../../../scripts/sprites/ci-bypass.js';

describe('isCiEnv', () => {
  it('returns false when CI is undefined or empty', () => {
    expect(isCiEnv({})).toBe(false);
    expect(isCiEnv({ CI: undefined })).toBe(false);
    expect(isCiEnv({ CI: '' })).toBe(false);
  });

  it('returns false for explicit falsy values', () => {
    expect(isCiEnv({ CI: '0' })).toBe(false);
    expect(isCiEnv({ CI: 'false' })).toBe(false);
    expect(isCiEnv({ CI: 'FALSE' })).toBe(false);
  });

  it('returns true for common truthy values', () => {
    expect(isCiEnv({ CI: 'true' })).toBe(true);
    expect(isCiEnv({ CI: '1' })).toBe(true);
    expect(isCiEnv({ CI: 'yes' })).toBe(true);
    // GitHub Actions sets CI=true — the actual observed value.
    expect(isCiEnv({ CI: 'true' })).toBe(true);
  });
});

describe('isCiPipelineBypassed', () => {
  it('returns false when not in CI (bypass has no meaning outside CI)', () => {
    expect(isCiPipelineBypassed({ SPRITES_ALLOW_CI_PIPELINE: 'true' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: '', SPRITES_ALLOW_CI_PIPELINE: 'true' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'false', SPRITES_ALLOW_CI_PIPELINE: 'true' })).toBe(false);
  });

  it('returns false in CI without the bypass flag', () => {
    expect(isCiPipelineBypassed({ CI: 'true' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: '' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: undefined })).toBe(false);
  });

  it('returns false for the flag values that are not explicit opt-in', () => {
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: '0' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'false' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'no' })).toBe(false);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'garbage' })).toBe(false);
  });

  it('returns true only when CI is set AND the flag is an accepted truthy form', () => {
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'true' })).toBe(true);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'TRUE' })).toBe(true);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: '1' })).toBe(true);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'yes' })).toBe(true);
    expect(isCiPipelineBypassed({ CI: 'true', SPRITES_ALLOW_CI_PIPELINE: '  true  ' })).toBe(true);
  });
});
