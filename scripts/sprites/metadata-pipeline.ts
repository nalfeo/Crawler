import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  ensureSentence,
  parseSpriteCatalog,
  type SpriteCatalog,
  type SpriteCatalogEntry,
  type SpriteCatalogRecord,
} from '../../src/shared/sprite-catalog.js';
import { writeCatalogJson } from './catalog-io.js';

export const DEFAULT_CATALOG_PATH = 'src/shared/data/sprite-catalog.json';
export const DEFAULT_MIN_SCORE = 70;

const draftSchema = z
  .object({
    description: z.string().trim().min(1),
    tags: z.array(z.string().trim().min(1)).default([]),
    tileConnectsTo: z.array(z.string().trim().min(1)).optional(),
    animationClips: z.array(z.string().trim().min(1)).optional(),
    rationale: z.string().trim().min(1).default('No rationale provided.'),
  })
  .strict();

const judgmentSchema = z
  .object({
    approved: z.boolean(),
    score: z.number().int().min(0).max(100),
    issues: z.array(z.string().trim().min(1)).default([]),
  })
  .strict();

export type MetadataDraft = z.infer<typeof draftSchema>;
export type DraftJudgment = z.infer<typeof judgmentSchema>;

interface ProviderContext {
  catalog: SpriteCatalog;
}

export interface MetadataProvider {
  readonly name: string;
  generate(entry: SpriteCatalogRecord, context: ProviderContext): Promise<MetadataDraft>;
  judge(
    entry: SpriteCatalogRecord,
    draft: MetadataDraft,
    context: ProviderContext,
  ): Promise<DraftJudgment>;
}

export interface PipelineOptions {
  provider: MetadataProvider;
  ids?: readonly string[];
  force?: boolean;
  minScore?: number;
}

export interface PipelineResult {
  updated: SpriteCatalog;
  changedCount: number;
  /** Catalog ids whose entry actually changed (drives durable re-queue). */
  changedIds: string[];
  processedCount: number;
  rejectedCount: number;
  skippedCount: number;
}

export type MetadataProviderMode = 'auto' | 'heuristic' | 'openai';

interface CliArgs {
  catalogPath: string;
  provider: MetadataProviderMode;
  ids?: string[];
  force: boolean;
  dryRun: boolean;
  minScore: number;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let catalogPath = DEFAULT_CATALOG_PATH;
  let provider: CliArgs['provider'] = 'auto';
  let force = false;
  let dryRun = false;
  let minScore = DEFAULT_MIN_SCORE;
  let ids: string[] | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--catalog') {
      catalogPath = argv[i + 1] ?? DEFAULT_CATALOG_PATH;
      i += 1;
    } else if (arg === '--provider') {
      const value = argv[i + 1];
      if (value === 'auto' || value === 'heuristic' || value === 'openai') {
        provider = value;
      }
      i += 1;
    } else if (arg === '--ids') {
      ids = (argv[i + 1] ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '');
      i += 1;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--min-score') {
      const parsed = Number.parseInt(argv[i + 1] ?? '', 10);
      if (Number.isFinite(parsed)) {
        minScore = parsed;
      }
      i += 1;
    }
  }

  return { catalogPath, provider, ids, force, dryRun, minScore };
}

function normalizeItems(items: readonly string[] | undefined): string[] {
  if (!items) return [];
  return [...new Set(items.map((value) => value.trim()).filter((value) => value !== ''))];
}

function tokenized(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token !== '');
}

function isLikelyTile(entry: SpriteCatalogEntry): boolean {
  const tokens = new Set([
    ...tokenized(entry.id),
    ...tokenized(entry.label),
    ...tokenized(entry.note ?? ''),
    ...entry.tags.flatMap((tag) => tokenized(tag)),
  ]);
  return (
    tokens.has('tile') ||
    tokens.has('wall') ||
    tokens.has('floor') ||
    tokens.has('road') ||
    tokens.has('path') ||
    tokens.has('terrain') ||
    tokens.has('water') ||
    tokens.has('lava') ||
    tokens.has('grass') ||
    tokens.has('snow') ||
    tokens.has('door')
  );
}

function buildHeuristicDescription(entry: SpriteCatalogRecord): string {
  if (entry.kind === 'sheet') {
    const label = entry.label.replace(/-/g, ' ');
    return ensureSentence(`${label} spritesheet for game asset lookup`);
  }

  if (entry.note) {
    return ensureSentence(entry.note);
  }

  return ensureSentence(`${entry.label.replace(/\./g, ' ')} sprite metadata entry`);
}

function buildHeuristicTags(entry: SpriteCatalogRecord): string[] {
  const tags = new Set<string>(entry.tags);
  tags.add(entry.kind);

  const entryTokens = [
    ...tokenized(entry.id),
    ...tokenized(entry.label),
    ...tokenized(entry.sheetKey),
  ];
  for (const token of entryTokens) {
    if (
      token === 'enemy' ||
      token === 'player' ||
      token === 'item' ||
      token === 'weapon' ||
      token === 'tile' ||
      token === 'vfx' ||
      token === 'sheet' ||
      token === 'projectile' ||
      token === 'character'
    ) {
      tags.add(token);
    }
  }

  return normalizeItems([...tags]);
}

function buildHeuristicConnectivity(
  entry: SpriteCatalogEntry,
  context: ProviderContext,
): string[] | undefined {
  if (!isLikelyTile(entry)) return undefined;

  const myTokens = new Set(tokenized(entry.id));
  const candidates = context.catalog
    .filter((candidate): candidate is SpriteCatalogEntry => candidate.kind === 'sprite')
    .filter((candidate) => candidate.id !== entry.id && candidate.sheetKey === entry.sheetKey)
    .filter((candidate) => isLikelyTile(candidate))
    .filter((candidate) => {
      const otherTokens = tokenized(candidate.id);
      return otherTokens.some((token) => myTokens.has(token));
    })
    .map((candidate) => candidate.id);

  return normalizeItems(candidates).slice(0, 8);
}

function buildHeuristicClips(entry: SpriteCatalogEntry): string[] | undefined {
  const tokens = new Set([
    ...tokenized(entry.id),
    ...tokenized(entry.label),
    ...entry.tags.flatMap((tag) => tokenized(tag)),
  ]);

  if (tokens.has('enemy') || tokens.has('player') || tokens.has('character')) {
    return ['idle', 'move'];
  }
  if (tokens.has('projectile') || tokens.has('vfx')) {
    return ['loop'];
  }
  return undefined;
}

export function createHeuristicProvider(): MetadataProvider {
  return {
    name: 'heuristic',
    async generate(entry, context) {
      if (entry.kind === 'sheet') {
        return {
          description: buildHeuristicDescription(entry),
          tags: buildHeuristicTags(entry),
          rationale: 'Generated from sheet id, label, and existing tags.',
        };
      }

      return {
        description: buildHeuristicDescription(entry),
        tags: buildHeuristicTags(entry),
        tileConnectsTo: buildHeuristicConnectivity(entry, context),
        animationClips: buildHeuristicClips(entry),
        rationale: 'Generated from sprite id, note, and neighborhood heuristics.',
      };
    },
    async judge(entry, draft, context) {
      const issues: string[] = [];
      let score = 100;

      const description = draft.description.trim();
      if (!/[.!?]$/u.test(description)) {
        score -= 25;
        issues.push('Description is missing terminal sentence punctuation.');
      }
      if (description.includes('\n')) {
        score -= 25;
        issues.push('Description must be a single sentence line.');
      }
      if (draft.tags.length === 0) {
        score -= 20;
        issues.push('Tags are empty.');
      }

      if (entry.kind === 'sprite' && draft.tileConnectsTo) {
        for (const target of draft.tileConnectsTo) {
          if (target === entry.id) {
            score -= 10;
            issues.push('Tile connectivity cannot include itself.');
            continue;
          }
          const exists = context.catalog.some((candidate) => candidate.id === target);
          if (!exists) {
            score -= 10;
            issues.push(`Connectivity target "${target}" does not exist in catalog.`);
          }
        }
      }

      if (entry.kind === 'sprite' && draft.animationClips) {
        if (draft.animationClips.some((clip) => /prev|next|frame/iu.test(clip))) {
          score -= 20;
          issues.push('Animation metadata should use clip refs, not frame-transition terms.');
        }
      }

      return {
        approved: issues.length === 0 && score >= DEFAULT_MIN_SCORE,
        score: Math.max(0, Math.min(100, score)),
        issues,
      };
    },
  };
}

function parseJsonFromModel(content: string): unknown {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/u);
  const jsonText = fenced?.[1] ?? trimmed;
  return JSON.parse(jsonText);
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function createOpenAiProviderFromEnv(): MetadataProvider {
  const chatUrl = getRequiredEnv('SPRITE_METADATA_CHAT_URL');
  const apiKey = getRequiredEnv('SPRITE_METADATA_API_KEY');
  const authHeader = process.env.SPRITE_METADATA_AUTH_HEADER?.trim() || 'Authorization';
  const authScheme = process.env.SPRITE_METADATA_AUTH_SCHEME?.trim() || 'Bearer';
  const model = process.env.SPRITE_METADATA_MODEL?.trim();

  const send = async (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
  ): Promise<string> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [authHeader]: authScheme ? `${authScheme} ${apiKey}` : apiKey,
    };

    const payload: Record<string, unknown> = {
      messages,
      temperature: 0.2,
    };
    if (model) {
      payload['model'] = model;
    }

    const response = await fetch(chatUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error(`Model request failed (${response.status}): ${await response.text()}`);
    }

    const json = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Model response did not include content.');
    }
    return content;
  };

  return {
    name: 'openai',
    async generate(entry, context) {
      const sameSheetIds =
        entry.kind === 'sprite'
          ? context.catalog
              .filter(
                (candidate): candidate is SpriteCatalogEntry =>
                  candidate.kind === 'sprite' && candidate.sheetKey === entry.sheetKey,
              )
              .map((candidate) => candidate.id)
          : [];

      const content = await send([
        {
          role: 'system',
          content:
            'You generate initial sprite metadata. Return JSON only. Keep description to one sentence. ' +
            'For tile assets, include tileConnectsTo as sprite IDs. For animation metadata, use clip references only and never prev/next frame links.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'generate_sprite_metadata',
            entry,
            sameSheetSpriteIds: sameSheetIds,
            outputSchema: {
              description: 'string (one sentence)',
              tags: 'string[]',
              tileConnectsTo: 'string[] optional',
              animationClips: 'string[] optional',
              rationale: 'string',
            },
          }),
        },
      ]);
      return draftSchema.parse(parseJsonFromModel(content));
    },
    async judge(entry, draft) {
      const content = await send([
        {
          role: 'system',
          content:
            'You judge sprite metadata quality. Return JSON only. Penalize missing one-sentence description, empty tags, ' +
            'invalid connectivity IDs, and any animation terms implying prev/next frame links.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'judge_sprite_metadata',
            entry,
            draft,
            outputSchema: {
              approved: 'boolean',
              score: 'integer 0-100',
              issues: 'string[]',
            },
          }),
        },
      ]);
      return judgmentSchema.parse(parseJsonFromModel(content));
    },
  };
}

function shouldProcessEntry(entry: SpriteCatalogRecord, force: boolean): boolean {
  if (force) return true;
  const hasPendingDescription = entry.description.trim().toLowerCase() === 'description pending.';
  if (hasPendingDescription) return true;
  if (entry.tags.length === 0) return true;
  return false;
}

function applyDraft(entry: SpriteCatalogRecord, draft: MetadataDraft): SpriteCatalogRecord {
  const description = ensureSentence(draft.description);
  const tags = normalizeItems(draft.tags);

  if (entry.kind === 'sheet') {
    return { ...entry, description, tags };
  }

  const tileConnectsTo = normalizeItems(draft.tileConnectsTo);
  const animationClips = normalizeItems(draft.animationClips);

  return {
    ...entry,
    description,
    tags,
    tile:
      tileConnectsTo.length > 0
        ? {
            connectsTo: tileConnectsTo.filter((target) => target !== entry.id),
          }
        : entry.tile,
    animation:
      animationClips.length > 0
        ? {
            clips: animationClips,
          }
        : entry.animation,
  };
}

export async function runMetadataPipeline(
  catalog: SpriteCatalog,
  options: PipelineOptions,
): Promise<PipelineResult> {
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const targetIds = options.ids ? new Set(options.ids) : undefined;
  const force = options.force ?? false;

  let changedCount = 0;
  const changedIds: string[] = [];
  let processedCount = 0;
  let rejectedCount = 0;
  let skippedCount = 0;
  const updated: SpriteCatalogRecord[] = [];

  for (const entry of catalog) {
    const targeted = !targetIds || targetIds.has(entry.id);
    if (!targeted || !shouldProcessEntry(entry, force)) {
      skippedCount += 1;
      updated.push(entry);
      continue;
    }

    processedCount += 1;
    const draft = await options.provider.generate(entry, { catalog });
    const judgment = await options.provider.judge(entry, draft, { catalog });

    if (!judgment.approved || judgment.score < minScore) {
      rejectedCount += 1;
      updated.push(entry);
      continue;
    }

    const nextEntry = applyDraft(entry, draft);
    if (JSON.stringify(nextEntry) !== JSON.stringify(entry)) {
      changedCount += 1;
      changedIds.push(entry.id);
    }
    updated.push(nextEntry);
  }

  return {
    updated: parseSpriteCatalog(updated),
    changedCount,
    changedIds,
    processedCount,
    rejectedCount,
    skippedCount,
  };
}

export async function resolveProvider(mode: MetadataProviderMode): Promise<MetadataProvider> {
  if (mode === 'heuristic') {
    return createHeuristicProvider();
  }
  if (mode === 'openai') {
    return createOpenAiProviderFromEnv();
  }

  if (process.env.SPRITE_METADATA_CHAT_URL && process.env.SPRITE_METADATA_API_KEY) {
    return createOpenAiProviderFromEnv();
  }
  return createHeuristicProvider();
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const provider = await resolveProvider(args.provider);
  const absoluteCatalogPath = resolve(args.catalogPath);
  const raw = JSON.parse(readFileSync(absoluteCatalogPath, 'utf-8'));
  const catalog = parseSpriteCatalog(raw);

  const result = await runMetadataPipeline(catalog, {
    provider,
    ids: args.ids,
    force: args.force,
    minScore: args.minScore,
  });

  process.stdout.write(
    [
      `provider: ${provider.name}`,
      `processed: ${result.processedCount}`,
      `changed: ${result.changedCount}`,
      `rejected: ${result.rejectedCount}`,
      `skipped: ${result.skippedCount}`,
    ].join('\n') + '\n',
  );

  if (args.dryRun) {
    return;
  }

  await writeCatalogJson(absoluteCatalogPath, result.updated);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
