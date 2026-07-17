import { stringify as stringifyYaml } from 'yaml';
import type { Brief } from './brief-schema.js';
import type { PostprocessOptions } from './postprocess.js';
import { getActiveModules, getPipelineForType } from './template-pipeline.js';
import type { RunStore } from './store/types.js';

export const POSTPROCESS_PROFILE_KEY = 'postprocess.overrides.json';
export const EFFECTIVE_PIPELINE_JSON_KEY = 'postprocess.pipeline.effective.json';
export const EFFECTIVE_PIPELINE_YAML_KEY = 'postprocess.pipeline.effective.yaml';
const MANUAL_ANCHOR_KEY = 'manual-anchor.json';
const FACING_OVERRIDE_KEY = 'facing-override.json';
const MANUAL_WEAPON_ANCHOR_KEY = 'weapon-anchor.json';

export interface ManualAnchorOverride {
  readonly variantIndex: number;
  readonly x: number;
  readonly y: number;
  readonly applyToAllVariants?: boolean;
  readonly source: 'manual';
  readonly updatedAt: string;
}

/**
 * Editor-authored weapon-attachment anchor for a run's variants.
 * Same shape as {@link ManualAnchorOverride} but for the weapon anchor;
 * stored as `weapon-anchor.json` in the run's store key.
 */
export interface ManualWeaponAnchorOverride {
  readonly variantIndex: number;
  readonly x: number;
  readonly y: number;
  readonly applyToAllVariants?: boolean;
  readonly source: 'manual';
  readonly updatedAt: string;
}

export interface FacingOverride {
  readonly variantIndex: number;
  readonly direction: 'left' | 'right';
  readonly applyToAllVariants?: boolean;
  readonly updatedAt: string;
}

export interface PersistedPostprocessProfile {
  readonly version: 1;
  readonly updatedAt: string;
  readonly options: PostprocessOptions;
}

export interface EffectivePipelineSnapshot {
  readonly version: 1;
  readonly generatedAt: string;
  readonly briefType: Brief['type'];
  readonly pipelineName: string;
  readonly modules: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly params: Readonly<Record<string, unknown>>;
  }>;
  readonly options: PostprocessOptions;
  readonly manualAnchor: ManualAnchorOverride | null;
  readonly facing: FacingOverride | null;
}

export async function readPostprocessProfile(
  store: RunStore,
  baseKey: string,
): Promise<PersistedPostprocessProfile | null> {
  const key = `${baseKey}/${POSTPROCESS_PROFILE_KEY}`;
  if (!(await store.has(key))) return null;
  try {
    const parsed = JSON.parse(
      (await store.get(key)).toString('utf8'),
    ) as Partial<PersistedPostprocessProfile>;
    if (
      parsed &&
      parsed.version === 1 &&
      typeof parsed.updatedAt === 'string' &&
      parsed.options &&
      typeof parsed.options === 'object'
    ) {
      return {
        version: 1,
        updatedAt: parsed.updatedAt,
        options: parsed.options as PostprocessOptions,
      };
    }
  } catch {
    // Ignore corrupt legacy profile payloads.
  }
  return null;
}

export async function writePostprocessProfile(
  store: RunStore,
  baseKey: string,
  options: PostprocessOptions,
  nowIso: string,
): Promise<void> {
  const key = `${baseKey}/${POSTPROCESS_PROFILE_KEY}`;
  const payload: PersistedPostprocessProfile = {
    version: 1,
    updatedAt: nowIso,
    options,
  };
  await store.put(key, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`));
}

export async function removePostprocessProfile(store: RunStore, baseKey: string): Promise<void> {
  await store.remove(`${baseKey}/${POSTPROCESS_PROFILE_KEY}`);
  await store.remove(`${baseKey}/${EFFECTIVE_PIPELINE_JSON_KEY}`);
  await store.remove(`${baseKey}/${EFFECTIVE_PIPELINE_YAML_KEY}`);
}

export async function readManualAnchor(
  store: RunStore,
  baseKey: string,
): Promise<ManualAnchorOverride | null> {
  const key = `${baseKey}/${MANUAL_ANCHOR_KEY}`;
  if (!(await store.has(key))) return null;
  try {
    const parsed = JSON.parse(
      (await store.get(key)).toString('utf8'),
    ) as Partial<ManualAnchorOverride>;
    if (
      parsed &&
      parsed.source === 'manual' &&
      Number.isInteger(parsed.variantIndex) &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.updatedAt === 'string'
    ) {
      return {
        variantIndex: parsed.variantIndex as number,
        x: parsed.x,
        y: parsed.y,
        ...(parsed.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
        source: 'manual',
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Ignore corrupt legacy manual-anchor payloads.
  }
  return null;
}

export async function writeManualAnchor(
  store: RunStore,
  baseKey: string,
  anchor: { variantIndex: number; x: number; y: number; applyToAllVariants?: boolean },
  nowIso: string,
): Promise<ManualAnchorOverride> {
  const payload: ManualAnchorOverride = {
    variantIndex: anchor.variantIndex,
    x: anchor.x,
    y: anchor.y,
    ...(anchor.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
    source: 'manual',
    updatedAt: nowIso,
  };
  await store.put(
    `${baseKey}/${MANUAL_ANCHOR_KEY}`,
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`),
  );
  return payload;
}

export async function removeManualAnchor(store: RunStore, baseKey: string): Promise<void> {
  await store.remove(`${baseKey}/${MANUAL_ANCHOR_KEY}`);
}

export async function readFacingOverride(
  store: RunStore,
  baseKey: string,
): Promise<FacingOverride | null> {
  const key = `${baseKey}/${FACING_OVERRIDE_KEY}`;
  if (!(await store.has(key))) return null;
  try {
    const parsed = JSON.parse((await store.get(key)).toString('utf8')) as Partial<FacingOverride>;
    if (
      parsed &&
      Number.isInteger(parsed.variantIndex) &&
      (parsed.direction === 'left' || parsed.direction === 'right') &&
      typeof parsed.updatedAt === 'string'
    ) {
      return {
        variantIndex: parsed.variantIndex as number,
        direction: parsed.direction,
        ...(parsed.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Ignore corrupt legacy facing payloads.
  }
  return null;
}

export async function writeFacingOverride(
  store: RunStore,
  baseKey: string,
  facing: { variantIndex: number; direction: 'left' | 'right'; applyToAllVariants?: boolean },
  nowIso: string,
): Promise<FacingOverride> {
  const payload: FacingOverride = {
    variantIndex: facing.variantIndex,
    direction: facing.direction,
    ...(facing.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
    updatedAt: nowIso,
  };
  await store.put(
    `${baseKey}/${FACING_OVERRIDE_KEY}`,
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`),
  );
  return payload;
}

export async function removeFacingOverride(store: RunStore, baseKey: string): Promise<void> {
  await store.remove(`${baseKey}/${FACING_OVERRIDE_KEY}`);
}

export async function readManualWeaponAnchor(
  store: RunStore,
  baseKey: string,
): Promise<ManualWeaponAnchorOverride | null> {
  const key = `${baseKey}/${MANUAL_WEAPON_ANCHOR_KEY}`;
  if (!(await store.has(key))) return null;
  try {
    const parsed = JSON.parse(
      (await store.get(key)).toString('utf8'),
    ) as Partial<ManualWeaponAnchorOverride>;
    if (
      parsed &&
      parsed.source === 'manual' &&
      Number.isInteger(parsed.variantIndex) &&
      typeof parsed.x === 'number' &&
      typeof parsed.y === 'number' &&
      typeof parsed.updatedAt === 'string'
    ) {
      return {
        variantIndex: parsed.variantIndex as number,
        x: parsed.x,
        y: parsed.y,
        ...(parsed.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
        source: 'manual',
        updatedAt: parsed.updatedAt,
      };
    }
  } catch {
    // Ignore corrupt legacy payloads.
  }
  return null;
}

export async function writeManualWeaponAnchor(
  store: RunStore,
  baseKey: string,
  anchor: { variantIndex: number; x: number; y: number; applyToAllVariants?: boolean },
  nowIso: string,
): Promise<ManualWeaponAnchorOverride> {
  const payload: ManualWeaponAnchorOverride = {
    variantIndex: anchor.variantIndex,
    x: anchor.x,
    y: anchor.y,
    ...(anchor.applyToAllVariants === true ? { applyToAllVariants: true } : {}),
    source: 'manual',
    updatedAt: nowIso,
  };
  await store.put(
    `${baseKey}/${MANUAL_WEAPON_ANCHOR_KEY}`,
    Buffer.from(`${JSON.stringify(payload, null, 2)}\n`),
  );
  return payload;
}

export async function removeManualWeaponAnchor(store: RunStore, baseKey: string): Promise<void> {
  await store.remove(`${baseKey}/${MANUAL_WEAPON_ANCHOR_KEY}`);
}

export async function writeEffectivePipelineSnapshot(args: {
  store: RunStore;
  baseKey: string;
  brief: Brief;
  options: PostprocessOptions;
  manualAnchor: ManualAnchorOverride | null;
  facing: FacingOverride | null;
  nowIso: string;
}): Promise<void> {
  const pipeline = getPipelineForType(args.brief.type);
  const active = getActiveModules(pipeline, args.brief.type);
  const snapshot: EffectivePipelineSnapshot = {
    version: 1,
    generatedAt: args.nowIso,
    briefType: args.brief.type,
    pipelineName: pipeline.name,
    modules: active.map((entry) => ({
      name: entry.name,
      type: entry.config.type,
      params: entry.config.params,
    })),
    options: args.options,
    manualAnchor: args.manualAnchor,
    facing: args.facing,
  };
  const json = `${JSON.stringify(snapshot, null, 2)}\n`;
  const yaml = `${stringifyYaml(snapshot)}`;
  await args.store.put(`${args.baseKey}/${EFFECTIVE_PIPELINE_JSON_KEY}`, Buffer.from(json));
  await args.store.put(`${args.baseKey}/${EFFECTIVE_PIPELINE_YAML_KEY}`, Buffer.from(yaml));
}
