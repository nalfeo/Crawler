import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ASSET_REQUEST_MARKER,
  fingerprintAssetRequest,
  parseAssetRequestIssueBody,
} from '../../../scripts/sprites/asset-request.js';

/**
 * Verbatim GitHub issue-form bodies for the real open `asset-request` issues.
 * #555 is the single-sentence baseline that parsed before this change; #588,
 * #607 and #626 are rich multi-sentence briefs (>240 chars) that were silently
 * skipped by the pre-relaxation parser.
 */
const issuesFixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../fixtures/asset-request-issues.json', import.meta.url)),
    'utf8',
  ),
) as {
  issues: Record<string, { title: string; body: string }>;
};

/** Build an issue-form rendered body from parts (mirrors GitHub's rendering). */
function formBody(parts: { name?: string; brief?: string; type?: string }): string {
  const lines: string[] = [];
  if (parts.name !== undefined) lines.push('### Name', parts.name, '');
  if (parts.brief !== undefined) lines.push('### Brief', parts.brief, '');
  if (parts.type !== undefined) lines.push('### Type', parts.type, '');
  return lines.join('\n');
}

/** Extract the verbatim brief text from a fixture body (single-line briefs). */
function fixtureBrief(body: string): string {
  const marker = '### Brief\n';
  return body.slice(body.indexOf(marker) + marker.length).trim();
}

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

  it('rejects invalid marker floors even when type is omitted', () => {
    for (const floor of ['21', '"12"']) {
      const body = [
        `<!-- ${ASSET_REQUEST_MARKER}`,
        `{"version":1,"name":"bone-dagger","briefSentence":"A chipped bone dagger with twine-wrapped handle.","floor":${floor}}`,
        '-->',
      ].join('\n');
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    }
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

  it('treats GitHub _No response_ sentinel in floor field as omitted (defaults to floor 1)', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Floor (optional)',
      '_No response_',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.floor).toBeUndefined();
    expect(parsed?.name).toBe('bone-dagger');
  });

  it('parses an explicit form-rendered floor when valid', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Floor (optional)',
      '5',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed).not.toBeNull();
    expect(parsed?.floor).toBe(5);
  });

  it('rejects form-rendered floor when out of range', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Floor (optional)',
      '21',
    ].join('\n');
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });

  it('rejects form-rendered floor when non-integer', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      '### Brief',
      'A chipped bone dagger with twine-wrapped handle.',
      '',
      '### Floor (optional)',
      '1.5',
    ].join('\n');
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });
});

describe('parseAssetRequestIssueBody — multi-sentence briefs', () => {
  // Byte-stable fingerprints for the real open issues. These lock normalization
  // so a future refactor cannot silently shift dedup identity (which would
  // spuriously re-enqueue already-generated assets).
  const realIssues: Array<{
    number: string;
    name: string;
    fingerprint: string;
    lastPhrase: string;
  }> = [
    {
      number: '588',
      name: 'rhea-vale',
      fingerprint: '518b3188ee489236ebe531541c9b225bc0eeba24a20792badf08d64ed1f42494',
      lastPhrase: 'helpless victim.',
    },
    {
      number: '607',
      name: 'tile-boss-staircase-floor',
      fingerprint: '4a67749e6656766b0013b53353b7d59d196b7bc4b9b7194ff7356664d2adead9',
      lastPhrase: 'special-room floor tile.',
    },
    {
      number: '626',
      name: 'ability-icon-veteran-instinct',
      fingerprint: '4b913adf3b8ef0367c53ff32580ded2faad0bf36f0ece6540d8ee5358efa526a',
      lastPhrase: 'surprised by them.',
    },
  ];

  it.each(realIssues)(
    'parses the rich multi-sentence brief from issue #$number ($name)',
    ({ number, name, fingerprint, lastPhrase }) => {
      const body = issuesFixture.issues[number]!.body;
      const parsed = parseAssetRequestIssueBody(body);
      const expectedBrief = fixtureBrief(body);

      expect(parsed).not.toBeNull();
      expect(parsed?.name).toBe(name);
      // Full section captured — not truncated to the first sentence.
      expect(parsed?.briefSentence).toBe(expectedBrief);
      expect(parsed?.briefSentence.length).toBeGreaterThan(240);
      expect(parsed?.briefSentence).toContain(lastPhrase);
      // Stored brief is a clean single line.
      expect(parsed?.briefSentence).not.toContain('\n');
      // Byte-stable fingerprint + internal consistency.
      expect(parsed?.fingerprint).toBe(fingerprint);
      expect(parsed?.fingerprint).toBe(fingerprintAssetRequest(name, expectedBrief));
    },
  );

  it('keeps the single-sentence baseline (#555) parsing with a stable fingerprint', () => {
    const body = issuesFixture.issues['555']!.body;
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('classified-dossier');
    expect(parsed?.briefSentence).toBe(fixtureBrief(body));
    // Normalization is a no-op for already-clean single-line briefs, so the
    // fingerprint is byte-identical to the pre-relaxation value.
    expect(parsed?.fingerprint).toBe(
      '656fe5b3f1c9ea41309604a1d187d75d7f426f5f9377db494af910852f16b853',
    );
  });

  it('captures a hard-wrapped multi-line brief and collapses it to one line', () => {
    const body = [
      '### Name',
      'gloom-lantern',
      '',
      '### Brief',
      'A rusted iron lantern that leaks green gloom-light.',
      'It sways on a bent hook and casts long, crawling shadows.',
      'Readable at gameplay scale; unmistakably a light source, not a weapon.',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    const expected =
      'A rusted iron lantern that leaks green gloom-light. It sways on a bent ' +
      'hook and casts long, crawling shadows. Readable at gameplay scale; ' +
      'unmistakably a light source, not a weapon.';
    expect(parsed?.name).toBe('gloom-lantern');
    expect(parsed?.briefSentence).toBe(expected);
    expect(parsed?.briefSentence).not.toContain('\n');
    expect(parsed?.fingerprint).toBe(fingerprintAssetRequest('gloom-lantern', expected));
  });

  it('accepts a short two-sentence brief (was blocked by the exactly-one-terminal rule)', () => {
    const body = formBody({
      name: 'ember-vial',
      brief: 'A small glass vial. It glows with trapped embers.',
    });
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('ember-vial');
    expect(parsed?.briefSentence).toBe('A small glass vial. It glows with trapped embers.');
  });

  it('stops the brief capture at a following ### Type heading and parses the type', () => {
    const body = formBody({
      name: 'rhea-vale',
      brief:
        'Rhea Vale is the player character. Medium build, practical outfit. ' +
        'Silhouette must read clearly at gameplay scale.',
      type: 'character',
    });
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('rhea-vale');
    expect(parsed?.type).toBe('character');
    expect(parsed?.briefSentence).toBe(
      'Rhea Vale is the player character. Medium build, practical outfit. ' +
        'Silhouette must read clearly at gameplay scale.',
    );
    // The type heading/value must not bleed into the brief.
    expect(parsed?.briefSentence).not.toContain('character\n');
    expect(parsed?.briefSentence).not.toContain('Type');
  });

  it('rejects a multi-sentence brief when the following ### Type is invalid', () => {
    const body = formBody({
      name: 'rhea-vale',
      brief: 'Rhea Vale is the player character. Determined expression, practical outfit.',
      type: 'not-a-real-type',
    });
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });

  it('normalizes CRLF bodies before parsing a multi-sentence brief', () => {
    const lfBody = formBody({
      name: 'tile-boss-staircase-floor',
      brief:
        'The floor of the boss chamber. Subtly distinct from regular stone. ' +
        'Seamless and suitable as a special-room floor tile.',
      type: 'tile',
    });
    const crlfBody = lfBody.replace(/\n/g, '\r\n');
    const parsed = parseAssetRequestIssueBody(crlfBody);
    expect(parsed?.name).toBe('tile-boss-staircase-floor');
    expect(parsed?.type).toBe('tile');
    expect(parsed?.briefSentence).toBe(
      'The floor of the boss chamber. Subtly distinct from regular stone. ' +
        'Seamless and suitable as a special-room floor tile.',
    );
    // CRLF must not survive into the stored brief.
    expect(parsed?.briefSentence).not.toContain('\r');
  });

  it('truncates the brief at an inner ### heading (documented section boundary)', () => {
    const body = [
      '### Name',
      'foo-thing',
      '',
      '### Brief',
      'First sentence about the thing.',
      '### Notes buried in the brief',
      'This trailing prose lives past the section boundary.',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.briefSentence).toBe('First sentence about the thing.');
    expect(parsed?.briefSentence).not.toContain('trailing prose');
  });

  it('collapses heavy internal whitespace on the form path before length checks', () => {
    // On the issue-form path the brief is normalized BEFORE validation, so a
    // whitespace-padded brief collapses to 1801 chars and is accepted. The raw
    // 4000-char cap only bites on the verbatim marker path (see marker suite).
    const brief = `${'a'.repeat(900)}${' '.repeat(3001)}${'b'.repeat(900)}`;
    const body = formBody({ name: 'foo-thing', brief });
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.briefSentence).toBe(`${'a'.repeat(900)} ${'b'.repeat(900)}`);
  });

  it('accepts a brief just under the normalized cap', () => {
    const brief = 'y'.repeat(1990);
    const body = formBody({ name: 'foo-thing', brief });
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.briefSentence).toBe(brief);
  });

  describe('reject cases', () => {
    it('rejects an empty brief section (### Brief followed immediately by ### Type)', () => {
      const body = ['### Name', 'foo-thing', '', '### Brief', '', '### Type', 'item'].join('\n');
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    });

    it('rejects a whitespace-only brief', () => {
      const body = formBody({ name: 'foo-thing', brief: '   \t  ' });
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    });

    it('rejects a brief shorter than the minimum length', () => {
      const body = formBody({ name: 'foo-thing', brief: 'tiny' });
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    });

    it('rejects a brief whose normalized length exceeds the cap', () => {
      // 2100 contiguous non-space chars: under the raw cap (4000) but over the
      // normalized cap (2000), isolating the normalized-length guard.
      const body = formBody({ name: 'foo-thing', brief: 'x'.repeat(2100) });
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    });

    it('rejects a body missing the Name section', () => {
      const body = ['### Brief', 'A perfectly valid multi-word brief sentence.'].join('\n');
      expect(parseAssetRequestIssueBody(body)).toBeNull();
    });
  });
});

describe('parseAssetRequestIssueBody — marker path with relaxed briefs', () => {
  it('accepts a multi-sentence marker briefSentence verbatim', () => {
    const brief =
      'A chipped bone dagger with a twine-wrapped handle. The blade is yellowed ' +
      'and notched. It reads clearly at gameplay scale.';
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      JSON.stringify({ version: 1, name: 'bone-dagger', briefSentence: brief, type: 'weapon' }),
      '-->',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    expect(parsed?.name).toBe('bone-dagger');
    expect(parsed?.type).toBe('weapon');
    // Machine payload is preserved byte-for-byte (no whitespace collapse).
    expect(parsed?.briefSentence).toBe(brief);
    expect(parsed?.fingerprint).toBe(fingerprintAssetRequest('bone-dagger', brief));
  });

  it('preserves embedded newlines in a marker briefSentence verbatim', () => {
    const brief = 'Line one of the brief.\nLine two adds detail.\nLine three sets the scale.';
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      JSON.stringify({ version: 1, name: 'bone-dagger', briefSentence: brief }),
      '-->',
    ].join('\n');
    const parsed = parseAssetRequestIssueBody(body);
    // Verbatim: the marker contract keeps the raw newlines; only the fingerprint
    // collapses them (so a marker and the equivalent form brief still match).
    expect(parsed?.briefSentence).toBe(brief);
    expect(parsed?.fingerprint).toBe(fingerprintAssetRequest('bone-dagger', brief));
  });

  it('rejects a marker briefSentence over the length cap (falls back, then null)', () => {
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      JSON.stringify({ version: 1, name: 'bone-dagger', briefSentence: 'z'.repeat(2100) }),
      '-->',
    ].join('\n');
    // Invalid payload → fall back to form parsing → no form Brief heading → null.
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });

  it('rejects a marker briefSentence whose raw length exceeds the cap even when it collapses small', () => {
    // Verbatim path: trimmed raw length 4801 (> 4000) though it would collapse to
    // 1801 chars — isolates the raw-input guard that runs before normalization.
    const brief = `${'a'.repeat(900)}${' '.repeat(3001)}${'b'.repeat(900)}`;
    const body = [
      '### Name',
      'bone-dagger',
      '',
      `<!-- ${ASSET_REQUEST_MARKER}`,
      JSON.stringify({ version: 1, name: 'bone-dagger', briefSentence: brief }),
      '-->',
    ].join('\n');
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });

  it('rejects a marker payload that leaks an unrendered template expression', () => {
    const body = [
      `<!-- ${ASSET_REQUEST_MARKER}`,
      JSON.stringify({
        version: 1,
        name: '${{ inputs.name }}',
        briefSentence: 'A valid enough brief sentence describing the sprite.',
      }),
      '-->',
    ].join('\n');
    // No form headings to fall back to → null (garbage never enqueued).
    expect(parseAssetRequestIssueBody(body)).toBeNull();
  });
});
