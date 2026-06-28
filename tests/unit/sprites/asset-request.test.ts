import { describe, expect, it } from 'vitest';
import {
  ASSET_REQUEST_MARKER,
  fingerprintAssetRequest,
  parseAssetRequestIssueBody,
} from '../../../scripts/sprites/asset-request.js';

describe('parseAssetRequestIssueBody', () => {
  it('parses the machine-readable marker payload', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      '{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle."}',
      '-->',
    ].join('\n');
    expect(parseAssetRequestIssueBody(body)).toEqual({
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: fingerprintAssetRequest(
        'bone-dagger',
        'A chipped bone dagger with twine-wrapped handle.',
      ),
    });
  });

  it('falls back to issue-form headings when marker is absent', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('bone-dagger');
    expect(parsed?.briefSentence).toContain('twine-wrapped');
  });

  it('falls back to issue-form headings when the marker payload is invalid', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      '{"version":1,"name":"${{ inputs.name }}","briefSentence":"${{ inputs.brief }}"}',
      '-->',
    ].join('\n');
    expect(parseAssetRequestIssueBody(body)).toEqual({
      name: 'bone-dagger',
      briefSentence: 'A chipped bone dagger with twine-wrapped handle.',
      fingerprint: fingerprintAssetRequest(
        'bone-dagger',
        'A chipped bone dagger with twine-wrapped handle.',
      ),
    });
  });
});
