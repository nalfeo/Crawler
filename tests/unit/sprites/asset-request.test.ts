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

  it('parses marker payload with valid type field', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      '{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle.","type":"weapon"}',
      '-->',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('bone-dagger');
    expect(parsed?.type).toBe('weapon');
  });

  it('rejects marker payload with invalid type field', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      '{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle.","type":"invalid-type"}',
      '-->',
    ].join('\n');
    // Should fall back to form parsing, which succeeds without the invalid type
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('bone-dagger');
    expect(parsed?.type).toBeUndefined();
  });

  it('parses form-rendered type field when valid', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Type',
      'weapon',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('bone-dagger');
    expect(parsed?.type).toBe('weapon');
  });

  it('rejects form-rendered type field when invalid', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Type',
      'invalid-type',
    ].join('\n');
    // Should reject entirely if form has a non-empty invalid type
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });
});
