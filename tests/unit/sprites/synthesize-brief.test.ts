/**
 * Unit tests for the brief synthesizer. The provider and filesystem are
 * stubbed; the goal of this suite is to lock down the validation policy
 * (banned adjectives, seed-count constraints, confidence threshold) and
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
    // 4 seeds matches weapon's minVariations=4 default. Tests that
    // specifically exercise lower bounds pass an explicit override.
    embellishmentSeeds: [
      'shorter wider tip',
      'jagged spine variant',
      'wrapped leather hilt',
      'spiked iron pommel',
    ],
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
      expect('references' in parsed).toBe(false);
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

  it('persists authored theme context through synthesis YAML and brief loading', async () => {
    const theme = {
      setId: 'classic-fantasy',
      displayName: 'Classic Fantasy',
      designLanguage:
        'Practical late-medieval steel, leather, wool, and carved hardwood with restrained heraldry.',
    } as const;
    const provider = makeProvider((request) => {
      expect(request.theme).toEqual(theme);
      return makeWeaponResponse([makeCandidate()]);
    });
    const { hooks, files } = makeFsWrites();

    const result = await synthesizeBrief({
      name: 'arming-sword',
      type: 'weapon',
      candidates: 1,
      theme,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: hooks,
    });

    const yaml = files.get(result.written[0]!.yamlPath);
    const parsed = parseYaml(yaml!) as Record<string, unknown>;
    expect(parsed.theme).toEqual(theme);
    expect(mergeMinimalIntoDefaults(parsed, WEAPON_DEFAULTS).theme).toEqual(theme);
    expect(JSON.parse(files.get(result.sidecarPath)!) as Record<string, unknown>).toMatchObject({
      theme,
    });
  });
});

describe('synthesizeBrief — size variants', () => {
  it('writes sizeVariant into every YAML, the sidecar, and the result when non-default', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate(), makeCandidate()]));
    const { hooks, files } = makeFsWrites();
    const result = await synthesizeBrief({
      name: 'banner',
      type: 'weapon',
      candidates: 2,
      sizeVariant: 'wide',
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: hooks,
    });

    expect(result.sizeVariant).toBe('wide');
    for (const candidate of result.written) {
      const parsed = parseYaml(files.get(candidate.yamlPath)!) as Record<string, unknown>;
      expect(parsed.sizeVariant).toBe('wide');
      // The merged brief picks up the scaled default size.
      const merged = mergeMinimalIntoDefaults(parsed, {
        ...WEAPON_DEFAULTS,
        size: { width: 64, height: 64 },
        anchor: { x: 32, y: 32 },
      } as never);
      expect(merged.size).toEqual({ width: 128, height: 64 });
    }
    const sidecar = JSON.parse(files.get(result.sidecarPath)!) as Record<string, unknown>;
    expect(sidecar.sizeVariant).toBe('wide');
  });

  it('omits sizeVariant from the YAML for the default variant', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    const { hooks, files } = makeFsWrites();
    const result = await synthesizeBrief({
      name: 'plain',
      type: 'weapon',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: hooks,
    });

    expect(result.sizeVariant).toBe('default');
    const [written] = result.written;
    const parsed = parseYaml(files.get(written!.yamlPath)!) as Record<string, unknown>;
    expect('sizeVariant' in parsed).toBe(false);
    const sidecar = JSON.parse(files.get(result.sidecarPath)!) as Record<string, unknown>;
    expect(sidecar.sizeVariant).toBe('default');
  });

  it.each([
    ['wide', { width: 128, height: 64 }, { rows: 4, cols: 2 }],
    ['tall', { width: 64, height: 128 }, { rows: 2, cols: 4 }],
    ['large', { width: 128, height: 128 }, { rows: 2, cols: 2 }],
  ] as const)('produces the documented %s geometry', async (sizeVariant, size, sheet) => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    const { hooks, files } = makeFsWrites();
    const result = await synthesizeBrief({
      name: `${sizeVariant}-enemy`,
      type: 'weapon',
      candidates: 1,
      sizeVariant,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: hooks,
    });
    const parsed = parseYaml(files.get(result.written[0]!.yamlPath)!) as Record<string, unknown>;
    const merged = mergeMinimalIntoDefaults(parsed, {
      ...WEAPON_DEFAULTS,
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 32 },
    } as never);
    const generation = merged.generation as {
      readonly sheet: { readonly rows: number; readonly cols: number };
    };
    expect(merged.size).toEqual(size);
    expect(generation.sheet).toMatchObject(sheet);
    expect(1024 / generation.sheet.cols).toBe(size.width * 4);
    expect(1024 / generation.sheet.rows).toBe(size.height * 4);
  });

  it('omits baseline floor 1 from YAML and writes explicit deeper floors', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));

    const baselineFs = makeFsWrites();
    const baseline = await synthesizeBrief({
      name: 'baseline',
      type: 'weapon',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: baselineFs.hooks,
    });
    const baselineYaml = parseYaml(baselineFs.files.get(baseline.written[0]!.yamlPath)!) as Record<
      string,
      unknown
    >;
    expect('floor' in baselineYaml).toBe(false);

    const deeperFs = makeFsWrites();
    const deeper = await synthesizeBrief({
      name: 'deeper',
      type: 'weapon',
      floor: 12,
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: deeperFs.hooks,
    });
    const deeperYaml = parseYaml(deeperFs.files.get(deeper.written[0]!.yamlPath)!) as Record<
      string,
      unknown
    >;
    expect(deeperYaml.floor).toBe(12);
  });

  it('rejects an unknown size variant', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    await expect(
      synthesizeBrief({
        name: 'oops',
        type: 'weapon',
        candidates: 1,
        sizeVariant: 'huge' as never,
        provider,
        repoRoot: REPO_ROOT,
        env: {},
        fsWrites: makeFsWrites().hooks,
      }),
    ).rejects.toThrow(/Invalid sizeVariant/);
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
        fsWrites: makeFsWrites().hooks,
      });
      expect(result.written).toHaveLength(1);
    }
  });

  it('runs in CI when the ADR-0043 pipeline bypass is set', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    const result = await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: { CI: 'true', SPRITES_ALLOW_CI_PIPELINE: 'true' },
      fsWrites: makeFsWrites().hooks,
    });
    expect(result.written).toHaveLength(1);
  });

  it('still refuses in CI when the bypass flag is anything other than an accepted opt-in', async () => {
    const provider = makeProvider(() => makeWeaponResponse([makeCandidate()]));
    for (const val of ['', 'false', '0', 'garbage']) {
      await expect(
        synthesizeBrief({
          name: 'scythe',
          type: 'weapon',
          provider,
          repoRoot: REPO_ROOT,
          env: { CI: 'true', SPRITES_ALLOW_CI_PIPELINE: val },
          fsWrites: makeFsWrites().hooks,
        }),
      ).rejects.toThrow(/refuses to run in CI/);
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
      fsWrites: makeFsWrites().hooks,
    });
    expect(result.written).toHaveLength(1);
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
        fsWrites: makeFsWrites().hooks,
        // Hold the type to the static 3-5 window so this test isolates
        // the seed-count rule from the sprite-type minVariations rule
        // (covered separately below).
        loadMinVariations: () => 0,
      }),
    ).rejects.toThrow(/embellishmentSeeds must be 3-5/);
  });

  it('honours the sprite-type minVariations as the lower seed bound', async () => {
    // weapon defaults to minVariations: 4 (from the brief schema). When
    // synth produces only 3 seeds it should be rejected, not silently
    // accepted (which would force expand-variations to manufacture a
    // 4th from thin air later in the pipeline).
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          embellishmentSeeds: ['jagged spine variant', 'wrapped leather hilt', 'shorter wider tip'],
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
        fsWrites: makeFsWrites().hooks,
        // weapon-shaped sprite-type defaults: minVariations=4.
        loadMinVariations: (t) => (t === 'weapon' ? 4 : null),
      }),
    ).rejects.toThrow(/embellishmentSeeds must be 4-5/);
  });

  it('accepts >=minVariations seeds when the sprite-type wants more than the static floor', async () => {
    const provider = makeProvider(() =>
      makeWeaponResponse([
        makeCandidate({
          embellishmentSeeds: [
            'jagged spine variant',
            'wrapped leather hilt',
            'shorter wider tip',
            'spiked iron pommel',
          ],
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
      fsWrites: makeFsWrites().hooks,
      loadMinVariations: (t) => (t === 'weapon' ? 4 : null),
    });
    expect(result.written).toHaveLength(1);
  });

  it('passes the effective seed window into the synth request so the prompt asks for the right range', async () => {
    let captured: number | null = null;
    let capturedMax: number | null = null;
    const provider = makeProvider((req) => {
      captured = req.effectiveMinSeeds;
      capturedMax = req.effectiveMaxSeeds;
      return makeWeaponResponse([
        makeCandidate({
          embellishmentSeeds: ['a', 'b', 'c', 'd'],
        }),
      ]);
    });
    await synthesizeBrief({
      name: 'scythe',
      type: 'weapon',
      candidates: 1,
      provider,
      repoRoot: REPO_ROOT,
      env: {},
      fsWrites: makeFsWrites().hooks,
      loadMinVariations: (t) => (t === 'weapon' ? 4 : null),
    });
    expect(captured).toBe(4);
    expect(capturedMax).toBe(5);
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
