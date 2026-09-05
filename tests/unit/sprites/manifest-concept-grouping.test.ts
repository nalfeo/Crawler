/**
 * Deterministic gate: ONE derivation of "which concept does this manifest row
 * belong to", and it is `generatedManifestConceptId`.
 *
 * Why this needs a gate rather than a code review
 * -----------------------------------------------
 * A generated manifest row's grouping key is NOT simply its `briefId`. Icon
 * batches generate many distinct concepts from ONE brief, so an icon row groups
 * by its own `spriteName` while every other row groups by brief lineage.
 * `generatedManifestConceptId(entry, manifestKey)` is the single function that
 * knows that, and the engine registry (`loadGeneratedManifest`) uses it — so it
 * is what the RUNTIME means by "concept".
 *
 * Every hand-rolled `normalizeConcept(entry.briefId)` is therefore a key that
 * disagrees with the runtime for icon-batch art, and each disagreement has
 * already shipped a real bug:
 *
 *   - the reference selector excluded the batch concept while grouping by the
 *     cell concept, so an ambiguous dislike excluded nothing;
 *   - the placeholder audit filed every cell of a batch under the batch
 *     concept, so a per-icon placeholder never met the art that replaces it.
 *
 * Both were invisible: no crash, no failing assertion, just a wrong answer. So
 * the rule lives here — a NEW hand-derived concept key fails this test until
 * somebody either switches to the shared helper or classifies the exception
 * with a reason.
 *
 * SCOPE LIMIT (deliberate, stated so nobody over-trusts this gate): it detects
 * a concept-NORMALIZATION HELPER applied to a manifest-entry field. It does NOT
 * detect grouping that touches `entry.briefId` with no helper at all — e.g.
 * `conceptsWithRealArt.add(entry.briefId)`. Catching that shape without false
 * positives needs an AST pass, not a regex. One such site is known and open:
 * `scripts/sprites/normalize-sprite-names.ts::planPlaceholderRetirements`
 * buckets by raw `briefId`, which for icon batches means one cell's real art
 * can mark a DIFFERENT cell's placeholder retirable. It is latent today (the
 * shipped manifest has 20 icon rows and zero icon placeholders), and fixing it
 * changes a destructive tool's semantics for ~600 non-icon rows, so it is
 * tracked as follow-up rather than silently allowlisted here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripSourceComments } from '../../helpers/source-comments.js';

/** Source trees that read generated manifest entries. */
const SCAN_ROOTS = ['scripts/sprites', 'src/shared', 'src/engine', 'src/game', 'src/core'];

/**
 * Any concept-normalization helper applied directly to a `.briefId` /
 * `.spriteName` property access. Captures the argument text so an expression
 * like `entry.briefId || mapKey` is caught too — assigning it to a local first
 * would otherwise be a trivial way around the gate.
 */
const NORMALIZE_CALL =
  /\b(?:normalizeConcept|normalizeSpriteConceptKey|normalizeSpriteLineageId|normalizeGeneratedSpriteConceptId)\s*\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g;

const ENTRY_FIELD = /\.(?:briefId|spriteName)\b/;

/**
 * Classified exceptions: the exact matched expressions that are allowed, with
 * the reason each is not a grouping key AND how many times it may appear.
 *
 * `occurrences` is load-bearing: without it, classifying one site would exempt
 * EVERY future occurrence of that same expression in the same file, so a real
 * violation could be added right next to a legitimate one and stay invisible.
 *
 * Keep this list SHORT. If you are adding an entry because you are indexing or
 * bucketing manifest rows, you are adding a bug — call
 * `generatedManifestConceptId(entry, manifestKey)` instead.
 */
const CLASSIFIED: ReadonlyArray<{
  readonly file: string;
  readonly expression: string;
  readonly occurrences: number;
  readonly reason: string;
}> = [
  {
    file: 'scripts/sprites/approve-cli.ts',
    expression: 'normalizeGeneratedSpriteConceptId(identity.briefId)',
    occurrences: 2,
    reason:
      'identity is a VariantIdentity resolved from summary.json, not a ManifestEntry — there is no ' +
      'entry to hand the shared helper, and a run being approved has exactly one concept.',
  },
  {
    file: 'scripts/sprites/sidecar/server.ts',
    expression: 'normalizeGeneratedSpriteConceptId(identity.briefId)',
    occurrences: 2,
    reason: 'Same VariantIdentity as approve-cli: the /approve and /accept lifecycle scope.',
  },
  {
    file: 'scripts/sprites/backfill-manifest-types.ts',
    expression: 'normalizeConcept(entry.briefId)',
    occurrences: 1,
    reason:
      'Type-INFERENCE cascade, not grouping. It runs only for rows with no valid entry.type, and ' +
      'generatedManifestConceptId branches on entry.type === "icon" — so for every row this code ' +
      'can see, the helper would return the identical brief-lineage key.',
  },
  {
    file: 'scripts/sprites/reference-selector.ts',
    expression: 'normalizeGeneratedSpriteConceptId(entry.briefId || entry.spriteName)',
    occurrences: 1,
    reason:
      'Generation-lineage self-exclusion PREDICATE, deliberately distinct from the grouping key ' +
      'computed one line above with the shared helper. It stops a regenerated icon batch from ' +
      'being handed its own previous cells as references.',
  },
];

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child);
  }
  return files;
}

interface Site {
  readonly file: string;
  readonly expression: string;
}

/** Every hand-derived concept-normalization site across the scanned trees. */
function findSites(): Site[] {
  const sites: Site[] = [];
  for (const root of SCAN_ROOTS) {
    for (const file of listSourceFiles(path.resolve(root))) {
      const source = stripSourceComments(readFileSync(file, 'utf8'));
      for (const match of source.matchAll(NORMALIZE_CALL)) {
        if (!ENTRY_FIELD.test(match[1] ?? '')) continue;
        sites.push({
          file: path.relative(process.cwd(), file).split(path.sep).join('/'),
          expression: match[0].replace(/\s+/g, ' '),
        });
      }
    }
  }
  return sites;
}

function isClassified(site: Site): boolean {
  return CLASSIFIED.some(
    (allowed) => allowed.file === site.file && allowed.expression === site.expression,
  );
}

/** `"<file>: <expression>"` → how many times it actually appears in the tree. */
function countSites(): Map<string, number> {
  const counts = new Map<string, number>();
  for (const site of findSites()) {
    const key = `${site.file}: ${site.expression}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

describe('generated-manifest concept keys come from one shared helper', () => {
  it('fails closed on a NEW hand-derived concept key', () => {
    const unclassified = [
      ...new Set(
        findSites()
          .filter((site) => !isClassified(site))
          .map((site) => `${site.file}: ${site.expression}`),
      ),
    ].sort();

    expect(
      unclassified,
      'Hand-derived manifest concept key(s) found. A generated manifest row groups by ' +
        'generatedManifestConceptId(entry, manifestKey) — which resolves icon-batch rows to their ' +
        'OWN cell concept, not the shared batch briefId. Fix: import it from ' +
        'src/shared/generated-assets.ts and use it. If this site genuinely is not a grouping key, ' +
        'classify it in CLASSIFIED in tests/unit/sprites/manifest-concept-grouping.test.ts with ' +
        'the reason.',
    ).toEqual([]);
  });

  /**
   * Classifying one site must not blanket-exempt every future occurrence of the
   * same expression in the same file — otherwise a real violation could be
   * added next to a legitimate one and never be seen.
   */
  it('pins the exact occurrence count of every classified exception', () => {
    const counts = countSites();
    const drifted = CLASSIFIED.filter(
      (allowed) =>
        (counts.get(`${allowed.file}: ${allowed.expression}`) ?? 0) !== allowed.occurrences,
    ).map(
      (allowed) =>
        `${allowed.file}: ${allowed.expression} — classified ${allowed.occurrences}, found ` +
        `${counts.get(`${allowed.file}: ${allowed.expression}`) ?? 0}`,
    );

    expect(
      drifted,
      'A classified exception changed its occurrence count. If you ADDED a call site, prove it is ' +
        'the same non-grouping case and bump `occurrences`; if you removed one, lower it. Do not ' +
        'let a new grouping key hide behind an existing classification.',
    ).toEqual([]);
  });

  it('keeps the classification list honest (no stale entries)', () => {
    const live = countSites();
    const stale = CLASSIFIED.map((allowed) => `${allowed.file}: ${allowed.expression}`)
      .filter((key) => !live.has(key))
      .sort();

    expect(
      stale,
      'Classified exception(s) no longer exist in the source. Delete them from CLASSIFIED so the ' +
        'list keeps describing the code that is actually there.',
    ).toEqual([]);
  });

  it('every classification states a reason', () => {
    for (const allowed of CLASSIFIED) {
      expect(
        allowed.reason.trim().length,
        `${allowed.file}: ${allowed.expression}`,
      ).toBeGreaterThan(40);
    }
  });

  /**
   * The scanner itself must not lose real code. Three ways a naive stripper
   * does, each of which silently hides call sites from every guard built on it.
   */
  it('does not lose code to a comment-opener inside a string or template literal', () => {
    const source = [
      "const glob = 'public/assets/generated/**';",
      'const tpl = `generated/*.png`;',
      '/**',
      ' * A docstring mentioning normalizeConcept(entry.briefId) in prose.',
      ' */',
      'const key = normalizeConcept(entry.briefId);',
    ].join('\n');

    const stripped = stripSourceComments(source);

    expect(stripped).toContain("const glob = 'public/assets/generated/**';");
    expect(stripped).toContain('const tpl = `generated/*.png`;');
    expect(stripped).toContain('const key = normalizeConcept(entry.briefId);');
    expect(stripped).not.toContain('in prose');
    expect([...stripped.matchAll(NORMALIZE_CALL)]).toHaveLength(1);
  });

  it('keeps code that FOLLOWS a same-line block comment', () => {
    const stripped = stripSourceComments('/* instrumented */ normalizeConcept(entry.briefId);');

    expect(stripped).toContain('normalizeConcept(entry.briefId);');
    expect([...stripped.matchAll(NORMALIZE_CALL)]).toHaveLength(1);
  });

  it('keeps code that follows a comment-opening line inside a template literal', () => {
    const source = [
      'const t = `',
      '/* not a comment */',
      '`;',
      'normalizeConcept(entry.briefId);',
    ].join('\n');

    const stripped = stripSourceComments(source);

    expect(stripped).toContain('normalizeConcept(entry.briefId);');
    expect([...stripped.matchAll(NORMALIZE_CALL)]).toHaveLength(1);
  });

  it('still removes a trailing line comment', () => {
    const stripped = stripSourceComments('const a = 1; // normalizeConcept(entry.briefId)');

    expect(stripped).toContain('const a = 1;');
    expect([...stripped.matchAll(NORMALIZE_CALL)]).toHaveLength(0);
  });

  it('keeps parser offsets aligned after non-BMP characters', () => {
    const source = [
      "const marker = '🍎';",
      '// normalizeConcept(entry.briefId)',
      'normalizeConcept(entry.spriteName);',
    ].join('\n');

    const stripped = stripSourceComments(source);

    expect(stripped).toContain("const marker = '🍎';");
    expect(stripped).toContain('normalizeConcept(entry.spriteName);');
    expect([...stripped.matchAll(NORMALIZE_CALL)]).toHaveLength(1);
  });
});
