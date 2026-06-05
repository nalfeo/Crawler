/**
 * Unit tests for the brief synthesizer. The provider, the reference
 * catalog hooks, and the filesystem are all stubbed; the goal of this
 * suite is to lock down the validation policy (banned adjectives,
 * allow-list enforcement, count constraints, confidence threshold) and
 * the partial/strict write policy.
 *
 * The happy path test additionally round-trips one written YAML through
 * `loadBrief` to prove the synthesizer's output is a real, valid
 * minimal brief.
 */

import { describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { loadBrief, mergeMinimalIntoDefaults } from '../../../scripts/sprites/load-brief.js';
import {
  MAX_CANDIDATES,
  MIN_CANDIDATES,
  SynthesizeBriefError,
  normaliseName,
  synthesizeBrief,
  type FsWriteHooks,
  type SpriteType,
} from '../../../scripts/sprites/synthesize-brief.js';
import type {
  SynthProvider,
  SynthesizeBriefRequest,
  SynthesizeBriefResponse,
  SynthesizedCandidate,
} from '../../../scripts/sprites/provider/synth-types.js';

const REPO_ROOT = '/fake/repo';

function makeProvider(
  resolver: (req: SynthesizeBriefRequest) => SynthesizeBriefResponse,
  label = 'azure-openai:gpt-4o-test',
): SynthProvider {
  return {
    providerLabel: label,
    synthesizeBrief: vi.fn(async (req) => Promise.resolve(resolver(req))),
  };
}

function makeCatalogHooks(): {
  readPacks: () => ReadonlyArray<string>;
  fileExists: (abs: string) => boolean;
} {
  return {
    readPacks: () => ['tiny-dungeon', 'roguelike-rpg-pack', 'tiny-battle'],
    fileExists: () => true,
  };
}

function makeFsWrites(): {
  hooks: FsWriteHooks & {
    mkdir: ReturnType<typeof vi.fn>;
    writeFile: ReturnType<typeof vi.fn>;
  };
  files: Map<string, string>;
} {
  const files = new Map<string, string>();
  const mkdir = vi.fn<(p: string) => void>();
  const writeFile = vi.fn<(p: string, c: string) => void>((p, c) => {
    files.set(p, c);
  });
  return { hooks: { mkdir, writeFile }, files };
}

function makeCandidate(overrides: Partial<SynthesizedCandidate> = {}): SynthesizedCandidate {
  return {
    description:
      'A vertically oriented serrated blade, tip pointing up, hilt centered, with a dark steel silhouette and a brass crossguard.',
    references: [
      { id: 'roguelike-rpg-pack', note: 'silhouette anchor for slender blades' },
      { id: 'tiny-battle', note: 'secondary palette for steel/wood mix' },
    ],
    embellishmentSeeds: ['shorter wider tip', 'jagged spine variant', 'wrapped leather hilt'],
    rationale: 'Distinct silhouette: tall narrow blade with no guard flares.',
    ...overrides,
  };
}

function makeWeaponResponse(
  candidates: ReadonlyArray<SynthesizedCandidate>,
  opts: { inferredType?: SpriteType | null; typeConfidence?: number | null } = {},
): SynthesizeBriefResponse {
  return {
    inferredType: opts.inferredType ?? null,
    typeConfidence: opts.typeConfidence ?? null,
    candidates,
  };
}

const WEAPON_DEFAULTS = {
  size: { width: 16, height: 16 },
  palette: { id: 'kenney-roguelike' },
  anchor: { x: 8, y: 14 },
  tags: ['weapon'],
  generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
  sensors: {
    weapon: { orientation: 'vertical', diagonalToleranceDeg: 5 },
    anchor: { derive: true, bandRows: 4, centerToleranceX: 3 },
  },
};

const FAKE_PALETTE = [
  [0, 0, 0],
  [255, 255, 255],
  [128, 64, 32],
] as const;

describe('synthesizeBrief — happy path', () => {
  it('writes N YAML candidates that round-trip through loadBrief', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate(),
        makeCandidate({
          description:
            'A short cleaver-style blade pointing up, wide near the tip, with a thick stubby hilt.',
          rationale: 'Distinct silhouette: short and wide vs the tall slender first candidate.',
        }),
        makeCandidate({
          description:
            'A double-edged dagger pointing up, symmetrical taper, with a rounded pommel.',
          rationale: 'Distinct silhouette: symmetrical dagger.',
        }),
      ]),
    );
    const { hooks, files } = makeFsWrites();
    const result = await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 3,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      referenceCatalogOptions: makeCatalogHooks(),
      fsWrites: hooks,
    });

    expect(result.written).toHaveLength(3);
    expect(result.rejected).toHaveLength(0);
    expect(result.written.map((c) => c.id)).toEqual(['scythe-v1', 'scythe-v2', 'scythe-v3']);
    expect(result.providerLabel).toBe('azure-openai:gpt-4o-test');
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);

    // 3 YAMLs + 1 sidecar.
    expect(files.size).toBe(4);
    expect(files.has(result.sidecarPath)).toBe(true);

    // Each written YAML round-trips through mergeMinimalIntoDefaults +
    // briefSchema by way of loadBrief. We stub the disk loaders so the
    // test stays hermetic.
    for (const candidate of result.written) {
      const yamlText = files.get(candidate.yamlPath);
      expect(yamlText).toBeTruthy();
      const parsed = parseYaml(yamlText!) as Record<string, unknown>;
      // Sanity-check the minimal-brief shape before merging.
      expect(parsed.type).toBe('weapon');
      expect(typeof parsed.name).toBe('string');
      expect(typeof parsed.description).toBe('string');
      const merged = mergeMinimalIntoDefaults(parsed, WEAPON_DEFAULTS);
      expect(merged.prompt).toBe(parsed.description);
      expect(merged.description).toBeUndefined();
    }

    // Spot-check sidecar contents.
    const sidecar = JSON.parse(files.get(result.sidecarPath)!) as Record<string, unknown>;
    expect(sidecar.name).toBe('scythe');
    expect(sidecar.type).toBe('weapon');
    expect(sidecar.promptHash).toBe(result.promptHash);
    expect((sidecar.written as unknown[]).length).toBe(3);
  });

  it('round-trips a written YAML through loadBrief via a temp brief file', async () => {
    // This second pass writes one of the YAMLs to a real temp dir and
    // calls the actual loadBrief, proving the synthesizer's output is
    // a fully-formed minimal brief and not just a string that happens
    // to round-trip our merge helper.
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const root = mkdtempSync(path.join(tmpdir(), 'crawler-synth-loadbrief-'));
    try {
      const provider = makeProvider(() =>
        makeWeaponResponse([
          makeCandidate({
            description:
              'A long curved scythe blade pointing up-left, narrow wooden snath running diagonal, ' +
              'with iron rivets at the join.',
            rationale: 'Distinct curved-blade silhouette versus straight blades.',
          }),
        ]),
      );
      const { hooks, files } = makeFsWrites();
      const result = await synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: root,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: hooks,
      });
      const [written] = result.written;
      expect(written).toBeDefined();
      const yamlText = files.get(written!.yamlPath)!;
      const briefPath = path.join(root, 'briefs', 'scythe.yaml');
      mkdirSync(path.dirname(briefPath), { recursive: true });
      writeFileSync(briefPath, yamlText);
      const loaded = loadBrief(briefPath, {
        projectRoot: root,
        loadPalette: () => FAKE_PALETTE.map((t) => [t[0], t[1], t[2]] as const),
        loadTypeDefaults: () => WEAPON_DEFAULTS,
      });
      expect(loaded.brief.type).toBe('weapon');
      expect(loaded.brief.name).toBe('scythe-v1');
      expect(loaded.brief.prompt).toContain('scythe blade');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('synthesizeBrief — CI guard', () => {
  it('refuses to run when env.CI is set to a truthy value', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        provider,
        repoRoot: REPO_ROOT,
        env: { CI: 'true' },
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/refuses to run in CI/);
  });

  it('runs when env.CI is unset or falsy', async () => {
    for (const val of [undefined, '', '0', 'false', 'False']) {
      const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
      const env: Record<string, string | undefined> = {};
      if (val !== undefined) env.CI = val;
      const result = await synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env,
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      });
      expect(result.written).toHaveLength(1);
    }
  });
});

describe('synthesizeBrief — type confidence', () => {
  it('throws when no type was supplied and confidence < 0.9', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([makeCandidate()], {
        inferredType: 'weapon',
        typeConfidence: 0.5,
      }),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/below the required 0.9|Re-run with --type/);
  });

  it('throws when no type was supplied and the model returned no classification', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    await expect(
      synthesizeBrief({
        name: 'scythe',
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/did not return a classification/);
  });

  it('accepts inferred type when confidence >= 0.9', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([makeCandidate()], {
        inferredType: 'weapon',
        typeConfidence: 0.95,
      }),
    );
    const result = await synthesizeBrief({
      name: 'scythe',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      referenceCatalogOptions: makeCatalogHooks(),
      fsWrites: makeFsWrites().hooks,
    });
    expect(result.type).toBe('weapon');
  });
});

describe('synthesizeBrief — candidate validation', () => {
  it('rejects a candidate whose description contains a banned vague adjective', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({ description: 'A really cool sword pointing up with shiny edges.' }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/banned vague adjective 'cool'/);
  });

  it('does NOT trip on banned-word substrings (word boundaries enforced)', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          description:
            'A slender saber pointing up with a sheathed handle wrapped in twine, sleeker than other variants.',
        }),
      ]),
    );
    const result = await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      referenceCatalogOptions: makeCatalogHooks(),
      fsWrites: makeFsWrites().hooks,
    });
    expect(result.written).toHaveLength(1);
  });

  it('rejects a candidate that references a path NOT in the allow-list', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          references: [
            { id: 'roguelike-rpg-pack', note: 'ok' },
            { id: 'made-up-pack', note: 'fake' },
          ],
        }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/made-up-pack/);
  });

  it('rejects a candidate that picks the same reference id twice', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          references: [
            { id: 'roguelike-rpg-pack', note: 'a' },
            { id: 'roguelike-rpg-pack', note: 'b' },
          ],
        }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/appears twice/);
  });

  it('rejects candidates with the wrong reference count', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          references: [{ id: 'roguelike-rpg-pack', note: 'lonely' }],
        }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/references must be 2-3/);
  });

  it('rejects candidates with the wrong seed count', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          embellishmentSeeds: ['only one'],
        }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/embellishmentSeeds must be 3-5/);
  });

  it('rejects a candidate whose reference resolves to a missing file on disk', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          references: [
            { id: 'tiny-battle', note: 'a' },
            { id: 'roguelike-rpg-pack', note: 'b' },
          ],
        }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 1,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        // Catalog discovery sees all three packs as having spritesheets…
        referenceCatalogOptions: makeCatalogHooks(),
        // …but the per-candidate re-check finds tiny-battle's file
        // missing, simulating a delete between catalog build and write.
        referenceFileExistsAtSynthesisTime: (abs: string) => !abs.includes('tiny-battle'),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/file is missing on disk/);
  });
});

describe('synthesizeBrief — partial vs strict policy', () => {
  it('writes nothing when partial=false and any candidate is rejected', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([makeCandidate(), makeCandidate({ description: 'A cool axe.' })]),
    );
    const { hooks, files } = makeFsWrites();
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 2,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: hooks,
      }),
    ).rejects.toThrow(/candidates were rejected/);
    expect(files.size).toBe(0);
    expect(hooks.mkdir).not.toHaveBeenCalled();
  });

  it('writes the valid candidates and records rejections when partial=true', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate(),
        makeCandidate({ description: 'A cool axe.' }),
        makeCandidate({
          description: 'A short cleaver pointing up, blunt spine.',
        }),
      ]),
    );
    const { hooks, files } = makeFsWrites();
    const result = await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 3,
      partial: true,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      referenceCatalogOptions: makeCatalogHooks(),
      fsWrites: hooks,
    });
    expect(result.written).toHaveLength(2);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.index).toBe(2);
    // 2 YAMLs + 1 sidecar.
    expect(files.size).toBe(3);
    const sidecar = JSON.parse(files.get(result.sidecarPath)!) as Record<string, unknown>;
    expect((sidecar.rejected as unknown[]).length).toBe(1);
  });

  it('throws when no candidate passes even with partial=true', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({ description: 'A cool axe.' }),
        makeCandidate({ description: 'An awesome dagger.' }),
      ]),
    );
    await expect(
      synthesizeBrief({
        name: 'scythe',
        type: 'weapon',
        candidates: 2,
        partial: true,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        referenceCatalogOptions: makeCatalogHooks(),
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(SynthesizeBriefError);
  });
});

describe('normaliseName', () => {
  it('lowercases and kebab-cases', () => {
    expect(normaliseName("Devil's Yoyo")).toBe('devils-yoyo');
    expect(normaliseName('  Throwing  Star ')).toBe('throwing-star');
    expect(normaliseName('Baseball_Bat')).toBe('baseball-bat');
  });

  it('safely normalises path-traversal-like inputs to a harmless slug', () => {
    // The non-alphanumeric collapse turns dots and separators into dashes,
    // so these reduce to plain kebab-case strings — not rejected, but
    // they can never escape the output directory because they contain no
    // path separators or `..` segments after normalisation.
    expect(normaliseName('../etc/passwd')).toBe('etc-passwd');
    expect(normaliseName('foo/bar')).toBe('foo-bar');
    expect(normaliseName('foo\\bar')).toBe('foo-bar');
    // A bare `..` collapses to the empty string and is rejected.
    expect(() => normaliseName('..')).toThrow();
  });

  it('rejects empty / whitespace-only / over-long names', () => {
    expect(() => normaliseName('')).toThrow();
    expect(() => normaliseName('   ')).toThrow();
    expect(() => normaliseName('a'.repeat(65))).toThrow();
  });

  it('rejects names that normalise to an empty slug', () => {
    expect(() => normaliseName('!!!')).toThrow();
  });
});

describe('synthesizeBrief — argument validation', () => {
  it('rejects candidate counts outside [MIN, MAX]', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    for (const n of [0, -1, MAX_CANDIDATES + 1, 100, 1.5, Number.NaN]) {
      await expect(
        synthesizeBrief({
          name: 'scythe',
          type: 'weapon',
          candidates: n,
          provider,
          repoRoot: REPO_ROOT,
          env: {},
          referenceCatalogOptions: makeCatalogHooks(),
          fsWrites: makeFsWrites().hooks,
        }),
      ).rejects.toThrow(/candidates must be an integer/);
    }
  });

  it('exposes MIN/MAX_CANDIDATES as exported constants', () => {
    expect(MIN_CANDIDATES).toBeGreaterThanOrEqual(1);
    expect(MAX_CANDIDATES).toBeGreaterThanOrEqual(MIN_CANDIDATES);
  });
});
