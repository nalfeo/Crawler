import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  FLOOR2_BOSS_ABILITY_CATALOG,
  bossAbilityCatalogSchema,
  formatBossAbilityAnnouncement,
  getFloor2BossAbilityByBossId,
  getFloor2BossAbilityById,
  loadFloor2BossAbilityCatalog,
  toBossAbilityCodexEntry,
} from '../../src/shared/boss-abilities.js';
import { loadFamilies } from '../../src/shared/data/families.js';
import { floor2EnemyPack } from '../../src/shared/enemy-packs.js';
import {
  enemyVariantFromTextureId,
  generatedBriefIdForEnemy,
} from '../../src/engine/phaser-bridge/sprite-kind.js';
import {
  FLOOR2_BOSS_ABILITY_STATUS,
  bossAbilityStatusPackSchema,
  buildBossAbilityStatusRecords,
  deriveBossAbilityDeliveryStage,
  formatBossAbilityStatusReport,
  loadFloor2BossAbilityStatus,
} from '../../scripts/agent/boss-ability-status-lib.js';
import { loadShippedManifest } from '../helpers/generated-manifest.js';

const manifestSchema = z
  .object({
    entries: z.record(
      z.string(),
      z
        .object({
          briefId: z.string().min(1),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function effectValuesForBoss(
  bossArchetypeId: string,
): ReadonlyMap<string, string | number | boolean> {
  const ability = getFloor2BossAbilityByBossId(bossArchetypeId);
  if (ability === undefined) throw new Error(`Missing ability for ${bossArchetypeId}`);
  return new Map(ability.effect.designValues.map((value) => [value.id, value.value]));
}

describe('Floor 2 boss ability catalog', () => {
  it('parses as a versioned strict pack', () => {
    expect(() => bossAbilityCatalogSchema.parse(FLOOR2_BOSS_ABILITY_CATALOG)).not.toThrow();
    expect(() => loadFloor2BossAbilityCatalog()).not.toThrow();
    expect(FLOOR2_BOSS_ABILITY_CATALOG.schemaVersion).toBe('boss-abilities/v1');
  });

  it('forms an exact family, boss, and catalog bijection', () => {
    const bosses = floor2EnemyPack.archetypes.filter((archetype) => archetype.isBoss === true);
    const families = loadFamilies();
    const catalogBossIds = new Set(
      FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => ability.bossArchetypeId),
    );
    const catalogFamilyIds = new Set(
      FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => ability.familyId),
    );

    expect(FLOOR2_BOSS_ABILITY_CATALOG.entries).toHaveLength(18);
    expect(catalogBossIds).toEqual(new Set(bosses.map((boss) => boss.id)));
    expect(catalogFamilyIds).toEqual(new Set(families.map((family) => family.id)));

    for (const boss of bosses) {
      const ability = getFloor2BossAbilityByBossId(boss.id);
      expect(ability?.bossName).toBe(boss.name);
      expect(ability?.familyId).toBe(boss.familyId);
      expect(getFloor2BossAbilityById(ability!.id)).toBe(ability);
    }
  });

  it('rejects duplicate or missing boss coverage', () => {
    const firstAbility = FLOOR2_BOSS_ABILITY_CATALOG.entries[0];
    expect(firstAbility).toBeDefined();
    expect(() =>
      bossAbilityCatalogSchema.parse({
        ...FLOOR2_BOSS_ABILITY_CATALOG,
        entries: [...FLOOR2_BOSS_ABILITY_CATALOG.entries, firstAbility],
      }),
    ).toThrow(/duplicate/);
    expect(() =>
      loadFloor2BossAbilityCatalog({
        ...FLOOR2_BOSS_ABILITY_CATALOG,
        entries: FLOOR2_BOSS_ABILITY_CATALOG.entries.slice(1),
      }),
    ).toThrow(/has no ability catalog entry/);
  });

  it('defines fixed recurring cadence and locked readable cues for every ability', () => {
    for (const ability of FLOOR2_BOSS_ABILITY_CATALOG.entries) {
      expect(ability.timing.firstEligibleAfterMs).toBeGreaterThan(0);
      expect(ability.timing.cooldownMs).toBeGreaterThan(0);
      expect(ability.timing.cooldownAnchor).toBe('resolution');
      expect(ability.timing.randomJitterMs).toBe(0);
      expect(ability.targeting.tracksPlayer).toBe(false);
      expect(ability.telegraph.durationMs).toBeGreaterThan(0);
      expect(ability.telegraph.description.length).toBeGreaterThanOrEqual(40);
      expect(ability.attackName).toBe(ability.attackName.toLocaleUpperCase('en-US'));
      expect(formatBossAbilityAnnouncement(ability)).toBe(
        `${ability.attackName} — ${ability.announcementText}`,
      );

      const selfCue = ability.category === 'defense' || ability.category === 'self-buff';
      expect(ability.telegraph.dangerColor).toBe(selfCue ? 'ability-theme' : 'hostile-red');
      expect(ability.targeting.origin).toBe(selfCue ? 'follows-caster' : 'locked');
    }
  });

  it('rejects incomplete lane and sequential-annulus geometry', () => {
    const lane = FLOOR2_BOSS_ABILITY_CATALOG.entries.find(
      (ability) =>
        ability.telegraph.shape === 'lane' &&
        ability.telegraph.metrics.some((metric) => metric.id === 'length-mode'),
    );
    const laneAndCircle = FLOOR2_BOSS_ABILITY_CATALOG.entries.find(
      (ability) => ability.telegraph.shape === 'lane-and-circle',
    );
    const sequentialAnnuli = FLOOR2_BOSS_ABILITY_CATALOG.entries.find(
      (ability) => ability.telegraph.shape === 'sequential-annuli',
    );
    if (lane === undefined || laneAndCircle === undefined || sequentialAnnuli === undefined) {
      throw new Error('Expected representative Floor 2 telegraph shapes');
    }

    const withMetrics = (abilityId: string, metricIds: readonly string[]) => ({
      ...FLOOR2_BOSS_ABILITY_CATALOG,
      entries: FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) =>
        ability.id === abilityId
          ? {
              ...ability,
              telegraph: {
                ...ability.telegraph,
                metrics: ability.telegraph.metrics.filter((metric) =>
                  metricIds.includes(metric.id),
                ),
              },
            }
          : ability,
      ),
    });

    expect(() => bossAbilityCatalogSchema.parse(withMetrics(lane.id, ['width']))).toThrow(
      /lane telegraph requires length metric/,
    );
    expect(() =>
      bossAbilityCatalogSchema.parse(withMetrics(lane.id, ['width', 'length-mode'])),
    ).not.toThrow();
    expect(() =>
      bossAbilityCatalogSchema.parse(
        withMetrics(laneAndCircle.id, ['lane-width', 'endpoint-radius']),
      ),
    ).toThrow(/lane-and-circle telegraph requires length metric/);
    expect(() =>
      bossAbilityCatalogSchema.parse(
        withMetrics(sequentialAnnuli.id, ['band-count', 'max-radius']),
      ),
    ).toThrow(/sequential-annuli telegraph requires metric.*band-width/);
  });

  it('rejects malformed telegraph metric value types and units at the catalog boundary', () => {
    const queen = getFloor2BossAbilityByBossId('faerie-boss');
    if (queen === undefined) throw new Error('Expected Queen Mab ability');

    const mutateRadius = (value: string | number, unit: string) => ({
      ...FLOOR2_BOSS_ABILITY_CATALOG,
      entries: FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) =>
        ability.id === queen.id
          ? {
              ...ability,
              telegraph: {
                ...ability.telegraph,
                metrics: ability.telegraph.metrics.map((metric) =>
                  metric.id === 'radius' ? { ...metric, value, unit } : metric,
                ),
              },
            }
          : ability,
      ),
    });

    const wrongUnit = bossAbilityCatalogSchema.safeParse(mutateRadius('wide', 'mode'));
    expect(wrongUnit.success).toBe(false);
    expect(wrongUnit.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'metric "radius" must have unit "feet", got "mode"',
        }),
        expect.objectContaining({
          message: 'metric "radius" must be a positive finite number',
        }),
      ]),
    );

    const wrongValueType = bossAbilityCatalogSchema.safeParse(mutateRadius('wide', 'feet'));
    expect(wrongValueType.success).toBe(false);
    expect(wrongValueType.error?.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'metric "radius" must be a positive finite number',
        }),
      ]),
    );
  });

  it('preserves Queen Mab Tarnish as the exact first vertical slice', () => {
    const queen = getFloor2BossAbilityByBossId('faerie-boss');
    expect(queen).toMatchObject({
      id: 'queen-mab-verdigris-glamour',
      attackName: 'VERDIGRIS GLAMOUR',
      announcementText: 'All that glitters will corrode!',
      timing: {
        firstEligibleAfterMs: 9000,
        cooldownMs: 9000,
        cooldownAnchor: 'resolution',
        randomJitterMs: 0,
      },
      targeting: {
        mode: 'player-position',
        lockAt: 'telegraph-start',
        tracksPlayer: false,
        origin: 'locked',
      },
      telegraph: {
        durationMs: 1500,
        shape: 'circle',
        dangerColor: 'hostile-red',
      },
    });
    expect(queen?.telegraph.metrics).toContainEqual({ id: 'radius', value: 12, unit: 'feet' });

    const values = effectValuesForBoss('faerie-boss');
    expect(values.get('debuff-id')).toBe('tarnished');
    expect(values.get('duration')).toBe(4000);
    expect(values.get('movement-speed-modifier')).toBe(-30);
    expect(values.get('attack-speed-modifier')).toBe(-25);
    expect(values.get('stacking')).toBe(false);
  });

  it("preserves Don Paco's THE BIG GOB contract", () => {
    const don = getFloor2BossAbilityByBossId('llama-boss');
    expect(don).toMatchObject({
      id: 'don-paco-the-big-gob',
      attackName: 'THE BIG GOB',
      announcementText: "Don Paco's painting the whole block!",
      timing: {
        firstEligibleAfterMs: 9000,
        cooldownMs: 9000,
        cooldownAnchor: 'resolution',
        randomJitterMs: 0,
      },
      targeting: {
        mode: 'player-direction',
        lockAt: 'telegraph-start',
        tracksPlayer: false,
        origin: 'locked',
      },
      telegraph: {
        durationMs: 1400,
        shape: 'cone',
        dangerColor: 'hostile-red',
      },
    });
    expect(don?.telegraph.metrics).toEqual(
      expect.arrayContaining([
        { id: 'angle', value: 70, unit: 'degrees' },
        { id: 'range', value: 30, unit: 'feet' },
        { id: 'projectile-count', value: 5, unit: 'count' },
      ]),
    );
    const values = effectValuesForBoss('llama-boss');
    expect(values.get('projectile-count')).toBe(5);
    expect(values.get('damage-profile')).toBe('moderate');
    expect(values.get('slick-duration')).toBe(4000);
    expect(values.get('slow-rule')).toBe('while-inside');
  });

  it('projects codex content without delivery metadata', () => {
    for (const ability of FLOOR2_BOSS_ABILITY_CATALOG.entries) {
      const codex = toBossAbilityCodexEntry(ability);
      expect(Object.keys(codex).sort()).toEqual([
        'attackName',
        'bossArchetypeId',
        'bossName',
        'counterplay',
        'fullDescription',
        'id',
        'shortDescription',
      ]);
      expect(codex.counterplay.length).toBeGreaterThanOrEqual(40);
    }
  });
});

describe('Floor 2 boss ability delivery status', () => {
  it('parses independently and covers every catalog ability exactly once', () => {
    expect(() => loadFloor2BossAbilityStatus()).not.toThrow();
    expect(FLOOR2_BOSS_ABILITY_STATUS.schemaVersion).toBe('boss-ability-status/v1');
    expect(FLOOR2_BOSS_ABILITY_STATUS.entries).toHaveLength(18);
    expect(new Set(FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) => entry.abilityId))).toEqual(
      new Set(FLOOR2_BOSS_ABILITY_CATALOG.entries.map((ability) => ability.id)),
    );
  });

  it('derives the current backlog as blocked with the active king-skritt slice in progress', () => {
    const records = buildBossAbilityStatusRecords();
    const stageCounts = records.reduce<Record<string, number>>((counts, record) => {
      counts[record.stage] = (counts[record.stage] ?? 0) + 1;
      return counts;
    }, {});
    expect(stageCounts).toMatchObject({ blocked: 17, 'in-progress': 1 });
    expect(Object.keys(stageCounts).sort()).toEqual(['blocked', 'in-progress']);

    // Queen Mab, Squick, Big Panda Wei, Sovereign Cap, Big Mama Bufo, and
    // Overseer Fizzwick runtime/telegraph/arena slices are verified,
    // but all stay blocked overall behind the separate production-enable gate
    // for real-game enablement/balance.
    const queen = records.find((record) => record.ability.bossArchetypeId === 'faerie-boss');
    expect(queen?.status.arenaLabState).toBe('verified');
    expect(queen?.status.runtimeState).toBe('verified');
    expect(queen?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    const squick = records.find((record) => record.ability.bossArchetypeId === 'ratfolk-boss');
    expect(squick?.status.arenaLabState).toBe('verified');
    expect(squick?.status.runtimeState).toBe('verified');
    expect(squick?.status.telegraphVfxState).toBe('verified');
    expect(squick?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    const panda = records.find((record) => record.ability.bossArchetypeId === 'panda-boss');
    expect(panda?.status.arenaLabState).toBe('verified');
    expect(panda?.status.runtimeState).toBe('verified');
    expect(panda?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    const fizzwick = records.find((record) => record.ability.bossArchetypeId === 'gnome-boss');
    expect(fizzwick?.status.arenaLabState).toBe('verified');
    expect(fizzwick?.status.runtimeState).toBe('verified');
    expect(fizzwick?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    const bufo = records.find((record) => record.ability.bossArchetypeId === 'toadkin-boss');
    expect(bufo?.status.arenaLabState).toBe('verified');
    expect(bufo?.status.runtimeState).toBe('verified');
    expect(bufo?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    const sovereign = records.find((record) => record.ability.bossArchetypeId === 'myconid-boss');
    expect(sovereign?.status.arenaLabState).toBe('verified');
    expect(sovereign?.status.runtimeState).toBe('verified');
    expect(sovereign?.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    // The other abilities remain blocked purely by the production-enable
    // gate; arena slices must not promote them to ready.
    for (const record of records.filter(
      (candidate) =>
        candidate.ability.bossArchetypeId !== 'faerie-boss' &&
        candidate.ability.bossArchetypeId !== 'ratfolk-boss' &&
        candidate.ability.bossArchetypeId !== 'panda-boss' &&
        candidate.ability.bossArchetypeId !== 'gnome-boss' &&
        candidate.ability.bossArchetypeId !== 'myconid-boss' &&
        candidate.ability.bossArchetypeId !== 'toadkin-boss',
    )) {
      expect(record.unresolvedBlockers).toEqual(['floor2-boss-production-enable']);
    }
  });

  it('promotes the not-started backlog only when the production-enable gate is verified', () => {
    const backlog = FLOOR2_BOSS_ABILITY_STATUS.entries.filter(
      (entry) => entry.runtimeState === 'not-started',
    );
    expect(backlog.every((entry) => entry.foundationState === 'verified')).toBe(true);

    const promoted = bossAbilityStatusPackSchema.parse({
      ...FLOOR2_BOSS_ABILITY_STATUS,
      gates: FLOOR2_BOSS_ABILITY_STATUS.gates.map((gate) =>
        gate.id === 'floor2-boss-production-enable' ? { ...gate, state: 'verified' } : gate,
      ),
    });
    const promotedBacklog = promoted.entries.filter((entry) =>
      backlog.some((candidate) => candidate.abilityId === entry.abilityId),
    );
    expect(promotedBacklog).toHaveLength(backlog.length);
    expect(
      promotedBacklog.every((entry) => deriveBossAbilityDeliveryStage(entry, promoted) === 'ready'),
    ).toBe(true);
  });

  it('reports authored animation lab work as in progress', () => {
    const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
    const withAnimationLabWork = bossAbilityStatusPackSchema.parse({
      ...FLOOR2_BOSS_ABILITY_STATUS,
      entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
        entry.abilityId === abilityId
          ? {
              ...entry,
              castAnimationState: 'in-progress',
              animationLabState: 'in-progress',
            }
          : entry,
      ),
    });
    const entry = withAnimationLabWork.entries.find(
      (candidate) => candidate.abilityId === abilityId,
    );

    expect(entry).toBeDefined();
    expect(deriveBossAbilityDeliveryStage(entry!, withAnimationLabWork)).toBe('in-progress');
  });

  it('requires evidence before animation lab work can be verified', () => {
    const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
    const withoutAnimationLabEvidence = {
      ...FLOOR2_BOSS_ABILITY_STATUS,
      entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
        entry.abilityId === abilityId
          ? {
              ...entry,
              castAnimationState: 'verified',
              animationLabState: 'verified',
              animationLabEvidence: null,
            }
          : entry,
      ),
    };

    expect(() => bossAbilityStatusPackSchema.parse(withoutAnimationLabEvidence)).toThrow(
      /verified animation-lab state requires evidence/,
    );
  });

  it('requires a canonical arena preset id before arena lab work can be verified', () => {
    const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
    const withoutArenaPresetId = {
      ...FLOOR2_BOSS_ABILITY_STATUS,
      entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
        entry.abilityId === abilityId
          ? {
              ...entry,
              arenaLabState: 'verified',
              arenaLabPresetId: null,
              arenaLabEvidence: 'seed-42-headless-and-arena-evidence',
            }
          : entry,
      ),
    };

    expect(() => bossAbilityStatusPackSchema.parse(withoutArenaPresetId)).toThrow(
      /verified arena-lab state requires a canonical combat-arena preset id/,
    );
  });

  it.each(['in-progress', 'not-requested', 'planned', 'requested'] as const)(
    'rejects verified animation-lab proof for a %s cast animation',
    (castAnimationState) => {
      const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
      const withoutProducedAnimation = {
        ...FLOOR2_BOSS_ABILITY_STATUS,
        entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
          entry.abilityId === abilityId
            ? {
                ...entry,
                castAnimationState,
                animationLabState: 'verified',
                animationLabEvidence: 'sprite-animation-lab-evidence',
              }
            : entry,
        ),
      };

      expect(() => bossAbilityStatusPackSchema.parse(withoutProducedAnimation)).toThrow(
        /verified animation-lab proof requires a produced cast animation/,
      );
    },
  );

  it('accepts verified animation-lab proof for an approved cast animation', () => {
    const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
    const withProducedAnimation = bossAbilityStatusPackSchema.parse({
      ...FLOOR2_BOSS_ABILITY_STATUS,
      gates: FLOOR2_BOSS_ABILITY_STATUS.gates.map((gate) => ({
        ...gate,
        state: 'verified',
      })),
      entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
        entry.abilityId === abilityId
          ? {
              ...entry,
              foundationState: 'verified',
              runtimeState: 'verified',
              telegraphVfxState: 'verified',
              arenaLabState: 'verified',
              arenaLabPresetId: 'f2-queen-mab',
              arenaLabEvidence: 'seed-42-headless-and-arena-evidence',
              castAnimationState: 'approved',
              animationLabState: 'verified',
              animationLabEvidence: 'sprite-animation-lab-evidence',
            }
          : entry,
      ),
    });
    const entry = withProducedAnimation.entries.find(
      (candidate) => candidate.abilityId === abilityId,
    );

    expect(entry).toBeDefined();
    expect(deriveBossAbilityDeliveryStage(entry!, withProducedAnimation)).toBe('verified');
  });

  it('requires verified foundation and resolved blockers before delivery is verified', () => {
    const abilityId = FLOOR2_BOSS_ABILITY_STATUS.entries[0]!.abilityId;
    const completedEntries = FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) =>
      entry.abilityId === abilityId
        ? {
            ...entry,
            foundationState: 'verified' as const,
            runtimeState: 'verified' as const,
            telegraphVfxState: 'verified' as const,
            arenaLabState: 'verified' as const,
            arenaLabPresetId: 'f2-queen-mab',
            arenaLabEvidence: 'seed-42-headless-and-arena-evidence',
          }
        : entry,
    );
    const unresolved = bossAbilityStatusPackSchema.parse({
      ...FLOOR2_BOSS_ABILITY_STATUS,
      entries: completedEntries,
    });
    const resolved = bossAbilityStatusPackSchema.parse({
      ...unresolved,
      gates: unresolved.gates.map((gate) => ({ ...gate, state: 'verified' })),
    });
    const withoutFoundation = bossAbilityStatusPackSchema.parse({
      ...resolved,
      entries: resolved.entries.map((entry) =>
        entry.abilityId === abilityId ? { ...entry, foundationState: 'not-started' } : entry,
      ),
    });

    const unresolvedEntry = unresolved.entries.find((entry) => entry.abilityId === abilityId);
    const resolvedEntry = resolved.entries.find((entry) => entry.abilityId === abilityId);
    const withoutFoundationEntry = withoutFoundation.entries.find(
      (entry) => entry.abilityId === abilityId,
    );
    expect(unresolvedEntry).toBeDefined();
    expect(resolvedEntry).toBeDefined();
    expect(withoutFoundationEntry).toBeDefined();
    expect(deriveBossAbilityDeliveryStage(unresolvedEntry!, unresolved)).toBe('blocked');
    expect(deriveBossAbilityDeliveryStage(withoutFoundationEntry!, withoutFoundation)).toBe(
      'designed',
    );
    expect(deriveBossAbilityDeliveryStage(resolvedEntry!, resolved)).toBe('verified');
  });

  it('derives art progress counts and exposes animation lab proof', () => {
    const [authored, planned] = FLOOR2_BOSS_ABILITY_STATUS.entries;
    expect(authored).toBeDefined();
    expect(planned).toBeDefined();
    const withArtProgress = bossAbilityStatusPackSchema.parse({
      ...FLOOR2_BOSS_ABILITY_STATUS,
      entries: FLOOR2_BOSS_ABILITY_STATUS.entries.map((entry) => {
        if (entry.abilityId === authored!.abilityId) {
          return {
            ...entry,
            codexIconState: 'verified',
            castAnimationState: 'approved',
            animationLabState: 'not-started',
          };
        }
        if (entry.abilityId === planned!.abilityId) {
          return {
            ...entry,
            castAnimationState: 'planned',
            animationLabState: 'not-started',
          };
        }
        return entry;
      }),
    });

    const report = formatBossAbilityStatusReport(withArtProgress);
    expect(report).toContain('codex-icons=1/18, authored-cast-animations=1/18');
    expect(report).toContain('animation=approved animation-lab=not-started');
    expect(report).toContain('animation=planned animation-lab=not-started');
  });

  it('prints a complete non-failing backlog report', () => {
    const report = formatBossAbilityStatusReport();
    expect(report).toContain('Floor 2 boss abilities: 18');
    expect(report).toContain('Stages: blocked=17, in-progress=1');
    for (const ability of FLOOR2_BOSS_ABILITY_CATALOG.entries) {
      expect(report).toContain(`${ability.bossName} — ${ability.attackName}`);
    }
  });
});

describe('Floor 2 boss ability art evidence', () => {
  it('matches the real runtime art resolver and shipped manifest for all 18 bosses', () => {
    const manifest = manifestSchema.parse(loadShippedManifest());
    const bossesById = new Map(
      floor2EnemyPack.archetypes
        .filter((archetype) => archetype.isBoss === true)
        .map((boss) => [boss.id, boss]),
    );

    for (const record of buildBossAbilityStatusRecords()) {
      const boss = bossesById.get(record.ability.bossArchetypeId);
      expect(boss).toBeDefined();
      const visualType = enemyVariantFromTextureId(boss!.spriteTexture);
      expect(generatedBriefIdForEnemy(visualType, record.ability.bossArchetypeId)).toBe(
        record.status.bossArt.runtimeBriefId,
      );
      expect(manifest.entries[record.status.bossArt.approvedAssetId]?.briefId).toBe(
        record.status.bossArt.runtimeBriefId,
      );
    }
  });

  it('claims source briefs only where committed files exist', () => {
    const records = buildBossAbilityStatusRecords();
    const committed = records.filter(
      ({ status }) => status.bossArt.evidenceKind === 'committed-brief',
    );
    const aliases = records.filter(({ status }) => status.bossArt.evidenceKind === 'runtime-alias');
    expect(committed).toHaveLength(4);
    expect(aliases.map(({ status }) => status.bossArt.runtimeBriefId).sort()).toEqual([
      'imps-boss',
      'raccoons-boss',
    ]);

    for (const { status } of committed) {
      expect(status.bossArt.sourceBriefPath).not.toBeNull();
      expect(existsSync(`${repoRoot}${status.bossArt.sourceBriefPath}`)).toBe(true);
    }
    for (const { status } of records.filter(
      ({ status }) => status.bossArt.evidenceKind !== 'committed-brief',
    )) {
      expect(status.bossArt.sourceBriefPath).toBeNull();
    }
  });
});
