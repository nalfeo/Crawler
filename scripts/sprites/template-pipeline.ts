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
import { parse as parseYaml } from 'yaml';
import type { SpriteType } from './brief-schema.js';
import { z } from 'zod';

/**
 * Module configuration: metadata and parameters for a processing step.
 */
const moduleConfigSchema = z
  .object({
    description: z.string().optional(),
    type: z.string(),
    enabled: z.boolean().default(true),
    enabledForTypes: z.array(z.string()).optional(),
    params: z.record(z.unknown()).default({}),
  })
  .strict();

/**
 * Pipeline template: modules and their execution order.
 */
const pipelineTemplateSchema = z
  .object({
    extends: z.string().optional(),
    name: z.string(),
    description: z.string().optional(),
    modules: z.record(moduleConfigSchema).default({}),
    pipeline: z.array(z.string()).default([]),
  })
  .strict();

export type ModuleConfig = z.infer<typeof moduleConfigSchema>;
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
  const parsed = parseYaml(content);
  return pipelineTemplateSchema.parse(parsed);
}

/**
 * Resolve a pipeline template with inheritance.
 * If the template has an `extends` key, load and merge the parent first.
 */
function resolveTemplate(spriteType: SpriteType, templatesDir?: string): ResolvedPipeline {
  const actualTemplatesDir =
    templatesDir ?? resolve(new URL(import.meta.url).pathname, '..', 'templates');
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

  // If this template extends another, load and merge the parent
  let merged: PipelineTemplate = { ...template };
  if (template.extends) {
    const parentFile = resolve(dirname(filePath), template.extends);
    const parent = resolveTemplateRec(parentFile, templatesDir, visited);

    // Merge modules: parent modules + overrides from this template
    const mergedModules: Record<string, ModuleConfig> = { ...parent.modules };
    for (const [key, moduleConfig] of Object.entries(template.modules)) {
      mergedModules[key] = { ...mergedModules[key], ...moduleConfig };
    }

    // Use parent pipeline if not overridden
    merged = {
      ...parent,
      ...template,
      modules: mergedModules,
      pipeline: template.pipeline.length > 0 ? template.pipeline : parent.pipeline,
    };
  }

  return {
    name: merged.name,
    description: merged.description,
    modules: merged.modules,
    pipeline: merged.pipeline,
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
  return pipeline.pipeline
    .map((moduleName) => ({
      name: moduleName,
      config: pipeline.modules[moduleName],
    }))
    .filter(({ config }) => {
      // Skip if module is globally disabled
      if (!config.enabled) return false;

      // Skip if module is only enabled for specific types and this isn't one
      if (config.enabledForTypes && !config.enabledForTypes.includes(spriteType)) {
        return false;
      }

      return true;
    });
}
