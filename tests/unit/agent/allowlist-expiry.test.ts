import { describe, expect, it } from 'vitest';
import {
  MIN_REASON_LENGTH,
  findAllowlistFindings,
  findExportedConstNames,
  findUnregisteredAllowlists,
  isAllowlistExportName,
  isNonTrivialReason,
  isRealIsoDate,
  type AllowlistFindingKind,
  type GovernedAllowlistEntry,
  type GovernedAllowlistSource,
} from '../../../scripts/agent/health/allowlist-expiry-lib.js';
import { KNIP_SUPPRESSIONS } from '../../../scripts/agent/health/knip-suppressions.js';
import { ALLOWLIST as ORPHANED_SYSTEMS_ALLOWLIST } from '../../../scripts/agent/health/orphaned-systems-lib.js';
import { TEST_SCAFFOLD_ALLOWLIST_ENTRIES } from '../../../scripts/agent/health/test-only-exports-lib.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TODAY = '2026-08-02';

const GOOD_REASON = 'Pending the wiring PR for the settlement planner; tracked in issue #100.';

function timeBounded(entries: readonly GovernedAllowlistEntry[]): GovernedAllowlistSource {
  return {
    name: 'FIXTURE_SUPPRESSIONS',
    file: 'scripts/agent/health/fixture.ts',
    policy: 'time-bounded',
    entries,
  };
}

function trackedPermanent(entries: readonly GovernedAllowlistEntry[]): GovernedAllowlistSource {
  return {
    name: 'FIXTURE_ALLOWLIST',
    file: 'scripts/agent/health/fixture.ts',
    policy: 'tracked-permanent',
    entries,
  };
}

const VALID_TIME_BOUNDED_ENTRY: GovernedAllowlistEntry = {
  key: 'src/shared/alpha.ts#alpha',
  reason: GOOD_REASON,
  expiresOn: '2026-12-31',
};

const VALID_PERMANENT_ENTRY: GovernedAllowlistEntry = {
  key: 'enemySpawnerSystem',
  reason: GOOD_REASON,
  trackingRef: 'ADR 0039',
  removeWhen: 'the labs stop using it or it moves outside src/game.',
};

function kinds(source: GovernedAllowlistSource): readonly AllowlistFindingKind[] {
  return findAllowlistFindings([source], TODAY).map((finding) => finding.kind);
}

// ---------------------------------------------------------------------------
// Date primitives
// ---------------------------------------------------------------------------

describe('isRealIsoDate', () => {
  it.each([
    ['2026-08-02', true],
    ['2026-02-28', true],
    ['2028-02-29', true], // leap year
    ['2026-02-29', false], // not a leap year
    ['2026-02-30', false], // impossible day
    ['2026-13-01', false], // impossible month
    ['2026-00-10', false],
    ['2026-8-2', false], // not zero-padded
    ['02-08-2026', false],
    ['', false],
  ])('isRealIsoDate(%s) === %s', (value, expected) => {
    expect(isRealIsoDate(value)).toBe(expected);
  });
});

describe('isNonTrivialReason', () => {
  it('accepts a specific justification', () => {
    expect(isNonTrivialReason(GOOD_REASON)).toBe(true);
  });

  it.each(['TODO', 'FIXME', 'n/a', 'N/A ', 'tbd', 'wip', 'temporary', 'hack'])(
    'rejects the placeholder reason %s',
    (reason) => {
      expect(isNonTrivialReason(reason)).toBe(false);
    },
  );

  it(`rejects a reason shorter than ${MIN_REASON_LENGTH} characters`, () => {
    expect(isNonTrivialReason('too short')).toBe(false);
  });

  it('rejects an undefined reason', () => {
    expect(isNonTrivialReason(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// findAllowlistFindings — clean cases (negative controls)
// ---------------------------------------------------------------------------

describe('findAllowlistFindings — valid sources', () => {
  it('reports nothing for a valid time-bounded source', () => {
    expect(findAllowlistFindings([timeBounded([VALID_TIME_BOUNDED_ENTRY])], TODAY)).toEqual([]);
  });

  it('reports nothing for a valid tracked-permanent source', () => {
    expect(findAllowlistFindings([trackedPermanent([VALID_PERMANENT_ENTRY])], TODAY)).toEqual([]);
  });

  it('accepts an entry that expires exactly today (not yet past its deadline)', () => {
    const entry = { ...VALID_TIME_BOUNDED_ENTRY, expiresOn: TODAY };
    expect(kinds(timeBounded([entry]))).toEqual([]);
  });

  it('reports nothing for an empty source', () => {
    expect(findAllowlistFindings([timeBounded([])], TODAY)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findAllowlistFindings — one table row per rule
// ---------------------------------------------------------------------------

describe('findAllowlistFindings — time-bounded rules', () => {
  const cases: ReadonlyArray<
    [AllowlistFindingKind, Omit<GovernedAllowlistEntry, 'key'> & { readonly key?: string }]
  > = [
    ['missing-reason', { expiresOn: '2026-12-31' }],
    ['trivial-reason', { reason: 'TODO', expiresOn: '2026-12-31' }],
    ['missing-expiry', { reason: GOOD_REASON }],
    ['malformed-expiry', { reason: GOOD_REASON, expiresOn: '31/12/2026' }],
    ['impossible-expiry', { reason: GOOD_REASON, expiresOn: '2026-02-30' }],
    ['expired', { reason: GOOD_REASON, expiresOn: '2026-08-01' }],
  ];

  it.each(cases)('flags %s', (expectedKind, entry) => {
    const result = kinds(timeBounded([{ key: 'entry-under-test', ...entry }]));
    expect(result).toEqual([expectedKind]);
  });

  it('flags a second impossible date form (month 13)', () => {
    const entry = { ...VALID_TIME_BOUNDED_ENTRY, expiresOn: '2026-13-01' };
    expect(kinds(timeBounded([entry]))).toEqual(['impossible-expiry']);
  });

  it('names the source, entry and remediation on an expired finding', () => {
    const entry = { ...VALID_TIME_BOUNDED_ENTRY, expiresOn: '2026-01-05' };
    const [finding] = findAllowlistFindings([timeBounded([entry])], TODAY);
    expect(finding).toMatchObject({
      kind: 'expired',
      source: 'FIXTURE_SUPPRESSIONS',
      file: 'scripts/agent/health/fixture.ts',
      entry: entry.key,
    });
    expect(finding?.message).toContain('2026-01-05');
    expect(finding?.message).toContain("don't extend the date");
    expect(finding?.remediation).toContain('remove the entry');
  });
});

describe('findAllowlistFindings — tracked-permanent rules', () => {
  it('flags a missing tracking reference', () => {
    const entry = { ...VALID_PERMANENT_ENTRY, trackingRef: undefined };
    expect(kinds(trackedPermanent([entry]))).toEqual(['missing-tracking-ref']);
  });

  it('flags a missing removal condition', () => {
    const entry = { ...VALID_PERMANENT_ENTRY, removeWhen: '   ' };
    expect(kinds(trackedPermanent([entry]))).toEqual(['missing-removal-condition']);
  });

  it('flags expiresOn on a permanent entry as mis-declared governance', () => {
    const entry = { ...VALID_PERMANENT_ENTRY, expiresOn: '2027-01-01' };
    expect(kinds(trackedPermanent([entry]))).toEqual(['unexpected-expiry']);
  });

  it('flags a missing reason independently of the permanent-policy fields', () => {
    const entry = { ...VALID_PERMANENT_ENTRY, reason: undefined };
    expect(kinds(trackedPermanent([entry]))).toEqual(['missing-reason']);
  });

  it('reports every violated permanent rule for one entry', () => {
    const entry: GovernedAllowlistEntry = {
      key: 'bare',
      reason: GOOD_REASON,
      expiresOn: '2027-01-01',
    };
    expect([...kinds(trackedPermanent([entry]))].sort()).toEqual([
      'missing-removal-condition',
      'missing-tracking-ref',
      'unexpected-expiry',
    ]);
  });

  it('does not apply expiry rules to a permanent source', () => {
    const stale = { ...VALID_PERMANENT_ENTRY, key: 'stale' };
    expect(findAllowlistFindings([trackedPermanent([stale])], '2099-01-01')).toEqual([]);
  });
});

describe('findAllowlistFindings — multiple sources', () => {
  it('aggregates findings across sources and preserves source identity', () => {
    const findings = findAllowlistFindings(
      [
        timeBounded([{ key: 'a', reason: GOOD_REASON, expiresOn: '2020-01-01' }]),
        trackedPermanent([{ key: 'b', reason: GOOD_REASON, trackingRef: '#1' }]),
      ],
      TODAY,
    );
    expect(findings.map((f) => [f.source, f.kind])).toEqual([
      ['FIXTURE_SUPPRESSIONS', 'expired'],
      ['FIXTURE_ALLOWLIST', 'missing-removal-condition'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Anti-bypass discovery
// ---------------------------------------------------------------------------

describe('findExportedConstNames / isAllowlistExportName', () => {
  it('extracts exported const names from source text', () => {
    const source = [
      "export const FOO_ALLOWLIST = ['a'];",
      'const PRIVATE_SUPPRESSIONS = [];',
      'export const helper = () => 1;',
      '  export const INDENTED_EXEMPTIONS = [];',
    ].join('\n');
    expect(findExportedConstNames(source)).toEqual([
      'FOO_ALLOWLIST',
      'helper',
      'INDENTED_EXEMPTIONS',
    ]);
  });

  it('extracts every exported const declarator from one declaration statement', () => {
    const source = 'export const harmless = 1, SNEAKY_ALLOWLIST = [], ALSO_EXCEPTIONS = [];';
    expect(findExportedConstNames(source)).toEqual([
      'harmless',
      'SNEAKY_ALLOWLIST',
      'ALSO_EXCEPTIONS',
    ]);
  });

  it('discovers names published through an export specifier list', () => {
    const source = [
      'const HIDDEN_ALLOWLIST = [];',
      'const LOCAL_LIST = [];',
      'const IRRELEVANT = 1;',
      'export { HIDDEN_ALLOWLIST, LOCAL_LIST as SNEAKY_EXEMPTIONS };',
    ].join('\n');
    expect(findExportedConstNames(source)).toEqual(['HIDDEN_ALLOWLIST', 'SNEAKY_EXEMPTIONS']);
  });

  it('ignores type-only exports and deduplicates re-exported const names', () => {
    const source = [
      'export type { FooAllowlistEntry };',
      'export const FOO_ALLOWLIST = [];',
      'export { FOO_ALLOWLIST };',
      'export { type BarAllowlist };',
    ].join('\n');
    expect(findExportedConstNames(source)).toEqual(['FOO_ALLOWLIST']);
  });

  it('is stateless across repeated calls (regex lastIndex is reset)', () => {
    const source = 'export const A_ALLOWLIST = [];\nexport const B_EXCEPTIONS = [];';
    expect(findExportedConstNames(source)).toEqual(findExportedConstNames(source));
  });

  it.each([
    ['FOO_ALLOWLIST', true],
    ['KNIP_SUPPRESSIONS', true],
    ['AUDIT_EXCEPTIONS', true],
    ['ROLE_EXEMPTIONS', true],
    ['WEAPON_DEFS', false],
  ])('isAllowlistExportName(%s) === %s', (name, expected) => {
    expect(isAllowlistExportName(name)).toBe(expected);
  });
});

describe('findUnregisteredAllowlists', () => {
  it('flags an allowlist-shaped export that is not registered', () => {
    const findings = findUnregisteredAllowlists(
      [{ name: 'SNEAKY_EXEMPTIONS', file: 'scripts/agent/health/sneaky.ts' }],
      ['scripts/agent/health/knip-suppressions.ts#KNIP_SUPPRESSIONS'],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'unregistered-allowlist',
      source: 'SNEAKY_EXEMPTIONS',
      file: 'scripts/agent/health/sneaky.ts',
    });
    expect(findings[0]?.remediation).toContain('check-allowlist-expiry.ts');
  });

  it('does not flag registered file#name pairs or non-allowlist names', () => {
    const findings = findUnregisteredAllowlists(
      [
        { name: 'KNIP_SUPPRESSIONS', file: 'scripts/agent/health/knip-suppressions.ts' },
        { name: 'WEAPON_DEFS', file: 'scripts/agent/health/other.ts' },
      ],
      ['scripts/agent/health/knip-suppressions.ts#KNIP_SUPPRESSIONS'],
    );
    expect(findings).toEqual([]);
  });

  it('still flags a registered NAME declared in a different file (anti-bypass)', () => {
    // Registration is scoped to file#name precisely so that a brand-new
    // `export const ALLOWLIST` cannot ride on the very generic name the
    // orphaned-systems list already claims. Matching on the bare name would
    // silently exempt this and defeat the whole fail-closed rule.
    const findings = findUnregisteredAllowlists(
      [{ name: 'ALLOWLIST', file: 'scripts/agent/health/brand-new-bypass.ts' }],
      ['scripts/agent/health/orphaned-systems-lib.ts#ALLOWLIST'],
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'unregistered-allowlist',
      source: 'ALLOWLIST',
      file: 'scripts/agent/health/brand-new-bypass.ts',
    });
  });

  it('reports one finding per file+name pair, deduplicated', () => {
    const discovered = [
      { name: 'DUPE_ALLOWLIST', file: 'scripts/a.ts' },
      { name: 'DUPE_ALLOWLIST', file: 'scripts/a.ts' },
      { name: 'DUPE_ALLOWLIST', file: 'scripts/b.ts' },
    ];
    expect(findUnregisteredAllowlists(discovered, []).map((f) => f.file)).toEqual([
      'scripts/a.ts',
      'scripts/b.ts',
    ]);
  });
});

// ---------------------------------------------------------------------------
// The real repo sources must be clean
// ---------------------------------------------------------------------------

describe('real registered allowlists', () => {
  const realSources: readonly GovernedAllowlistSource[] = [
    {
      name: 'KNIP_SUPPRESSIONS',
      file: 'scripts/agent/health/knip-suppressions.ts',
      policy: 'time-bounded',
      entries: KNIP_SUPPRESSIONS.map((s) => ({
        key: s.file,
        reason: s.reason,
        expiresOn: s.expiresOn,
      })),
    },
    {
      name: 'ALLOWLIST',
      file: 'scripts/agent/health/orphaned-systems-lib.ts',
      policy: 'tracked-permanent',
      entries: Object.entries(ORPHANED_SYSTEMS_ALLOWLIST).map(([name, entry]) => ({
        key: name,
        reason: entry.reason,
        trackingRef: entry.trackedIssue,
        removeWhen: entry.removeWhen,
      })),
    },
    {
      name: 'TEST_SCAFFOLD_ALLOWLIST_ENTRIES',
      file: 'scripts/agent/health/test-only-exports-lib.ts',
      policy: 'time-bounded',
      entries: TEST_SCAFFOLD_ALLOWLIST_ENTRIES.map((entry) => ({
        key: `${entry.file}#${entry.name}`,
        reason: entry.reason,
        expiresOn: entry.expiresOn,
      })),
    },
  ];

  it('produces no findings for the real assembled sources as of today', () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(findAllowlistFindings(realSources, today)).toEqual([]);
  });

  it('gives every test-scaffold entry a specific reason and a real future date', () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of TEST_SCAFFOLD_ALLOWLIST_ENTRIES) {
      expect(isNonTrivialReason(entry.reason), `${entry.file}#${entry.name}`).toBe(true);
      expect(isRealIsoDate(entry.expiresOn), `${entry.file}#${entry.name}`).toBe(true);
      expect(entry.expiresOn >= today, `${entry.file}#${entry.name}`).toBe(true);
    }
  });

  it('staggers test-scaffold review deadlines so they do not all come due at once', () => {
    const dates = new Set(TEST_SCAFFOLD_ALLOWLIST_ENTRIES.map((entry) => entry.expiresOn));
    expect(dates.size).toBeGreaterThan(5);
  });
});
