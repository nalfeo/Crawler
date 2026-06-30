/**
 * Post-processing pipeline template system.
 *
 * Loads YAML-based pipeline templates with module composition and inheritance.
 * Allows reusable, configurable post-processing pipelines per sprite type.
 *
 * Templates:
 * - Base template (base.yml): Core pipeline with all modules
 * - Per-type overrides (tile.yml, enemy.yml, etc.): Disable/reconfigure modules
 * - Inheritance: Templates can extend base.yml with overrides
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { parse as parseYaml } from 'yaml';
import { SPRITE_TYPES } from './brief-schema.js';
import { z } from 'zod';

type SpriteType = (typeof SPRITE_TYPES)[number];

/**
 * Module override patch as authored in templates. Child templates can provide
 * partial overrides (for example only `enabled: false`).
 */
const modulePatchSchema = z.object({
  description: z.string().optional(),
  type: z.string().optional(),
  enabled: z.boolean().optional(),
  enabledForTypes: z.array(z.string()).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});
type ModulePatch = z.infer<typeof modulePatchSchema>;

export interface ModuleConfig {
  readonly description?: string;
  readonly type: string;
  readonly enabled: boolean;
  readonly enabledForTypes?: ReadonlyArray<string>;
  readonly params: Readonly<Record<string, unknown>>;
}

/**
 * Pipeline template: modules and their execution order.
 */
const pipelineTemplateSchema = z.object({
  extends: z.string().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  modules: z.record(z.string(), modulePatchSchema).optional(),
  pipeline: z.array(z.string()).optional(),
});

export type PipelineTemplate = z.infer<typeof pipelineTemplateSchema>;

/**
 * Resolved pipeline: fully merged with inheritance applied.
 */
export interface ResolvedPipeline {
  readonly name: string;
  readonly description?: string;
  readonly modules: Readonly<Record<string, ModuleConfig>>;
  readonly pipeline: ReadonlyArray<string>;
}

/**
 * Load and parse a pipeline template from a YAML file.
 */
function loadTemplateYaml(filePath: string): PipelineTemplate {
  const content = readFileSync(filePath, 'utf8');
  const parsed = parseYaml(content) as unknown;
  return pipelineTemplateSchema.parse(parsed);
}

/**
 * Resolve a pipeline template with inheritance.
 * If the template has an `extends` key, load and merge the parent first.
 */
function resolveTemplate(spriteType: SpriteType, templatesDir?: string): ResolvedPipeline {
  const actualTemplatesDir =
    templatesDir ?? resolve(dirname(fileURLToPath(import.meta.url)), 'templates');
  const templateFile = resolve(actualTemplatesDir, `${spriteType}.yml`);
  return resolveTemplateRec(templateFile, actualTemplatesDir, new Set());
}

function resolveTemplateRec(
  filePath: string,
  templatesDir: string,
  visited: Set<string>,
): ResolvedPipeline {
  // Prevent infinite recursion
  if (visited.has(filePath)) {
    throw new Error(`Circular template inheritance detected: ${filePath}`);
  }
  visited.add(filePath);

  const template = loadTemplateYaml(filePath);
  const templateModules = template.modules ?? {};
  const templatePipeline = template.pipeline ?? [];

  // If this template extends another, load and merge the parent
  if (template.extends) {
    const parentFile = resolve(dirname(filePath), template.extends);
    const parent = resolveTemplateRec(parentFile, templatesDir, visited);

    // Merge modules: parent modules + overrides from this template
    const mergedModules: Record<string, ModuleConfig> = { ...parent.modules };
    for (const [key, modulePatch] of Object.entries(templateModules)) {
      const parentConfig = mergedModules[key];
      mergedModules[key] = resolveModuleConfig(key, modulePatch, parentConfig);
    }

    // Use parent pipeline if not overridden
    const finalPipeline = templatePipeline.length > 0 ? templatePipeline : parent.pipeline;

    return {
      name: template.name || parent.name || 'postprocess-pipeline',
      description: template.description ?? parent.description,
      modules: mergedModules,
      pipeline: finalPipeline,
    };
  }

  return {
    name: template.name || 'postprocess-pipeline',
    description: template.description,
    modules: Object.fromEntries(
      Object.entries(templateModules).map(([key, modulePatch]) => [
        key,
        resolveModuleConfig(key, modulePatch),
      ]),
    ),
    pipeline: templatePipeline,
  };
}

function resolveModuleConfig(
  moduleName: string,
  modulePatch: ModulePatch,
  parent?: ModuleConfig,
): ModuleConfig {
  const type = modulePatch.type ?? parent?.type;
  if (!type) {
    throw new Error(`Module "${moduleName}" is missing required "type"`);
  }

  return {
    type,
    enabled: modulePatch.enabled ?? parent?.enabled ?? true,
    params: { ...(parent?.params ?? {}), ...(modulePatch.params ?? {}) },
    description: modulePatch.description ?? parent?.description,
    enabledForTypes: modulePatch.enabledForTypes ?? parent?.enabledForTypes,
  };
}

/**
 * Get the resolved pipeline for a sprite type.
 * Caches results to avoid re-parsing on every call.
 */
const pipelineCache = new Map<SpriteType, ResolvedPipeline>();

export function getPipelineForType(
  spriteType: SpriteType,
  templatesDir?: string,
): ResolvedPipeline {
  if (pipelineCache.has(spriteType)) {
    return pipelineCache.get(spriteType)!;
  }

  const resolved = resolveTemplate(spriteType, templatesDir);
  pipelineCache.set(spriteType, resolved);
  return resolved;
}

/**
 * Clear the pipeline cache (useful for testing).
 */
export function clearPipelineCache(): void {
  pipelineCache.clear();
}

/**
 * Resolve a module for execution, filtering out disabled steps.
 */
export function getActiveModules(
  pipeline: ResolvedPipeline,
  spriteType: SpriteType,
): Array<{ name: string; config: ModuleConfig }> {
  const result: Array<{ name: string; config: ModuleConfig }> = [];
  for (const moduleName of pipeline.pipeline) {
    const config = pipeline.modules[moduleName];
    if (!config) continue;

    // Skip if module is globally disabled
    if (!config.enabled) continue;

    // Skip if module is only enabled for specific types and this isn't one
    if (config.enabledForTypes && !config.enabledForTypes.includes(spriteType)) {
      continue;
    }

    result.push({ name: moduleName, config });
  }
  return result;
}
