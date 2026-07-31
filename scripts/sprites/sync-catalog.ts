import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  SHEETS,
  SPRITES,
  type SpriteDef,
  type SpriteSheetDef,
} from '../../src/engine/sprites/index.js';
import {
  ensureSentence,
  parseSpriteCatalog,
  type SpriteCatalog,
  type SpriteCatalogEntry,
  type SpriteCatalogRecord,
  type SpriteSheetCatalogEntry,
} from '../../src/shared/sprite-catalog.js';
import { formatCatalogJsonToString, writeCatalogJson } from './catalog-io.js';
import { isGeneratedCatalogId } from '../../src/shared/generated-catalog.js';

const DEFAULT_CATALOG_PATH = 'src/shared/data/sprite-catalog.json';

interface CliArgs {
  outPath: string;
  check: boolean;
  prune: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  let outPath = DEFAULT_CATALOG_PATH;
  let check = false;
  let prune = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      outPath = argv[i + 1] ?? DEFAULT_CATALOG_PATH;
      i += 1;
    } else if (arg === '--check') {
      check = true;
    } else if (arg === '--prune') {
      prune = true;
    }
  }

  return { outPath, check, prune };
}

function defaultSheetDescription(sheet: SpriteSheetDef): string {
  return ensureSentence(sheet.description);
}

function defaultSpriteDescription(sprite: SpriteDef): string {
  if (sprite.note) {
    return ensureSentence(sprite.note);
  }
  return ensureSentence(`Sprite ${sprite.id} from ${sprite.sheetKey} frame ${sprite.frame}`);
}

function normalizeTags(tags: readonly string[] | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))];
}

function kindOrder(kind: SpriteCatalogRecord['kind']): number {
  return kind === 'sheet' ? 0 : 1;
}

function buildSheetEntry(
  sheet: SpriteSheetDef,
  existing: SpriteSheetCatalogEntry | undefined,
): SpriteSheetCatalogEntry {
  return {
    id: `sheet:${sheet.key}`,
    kind: 'sheet',
    label: sheet.key,
    description: ensureSentence(existing?.description ?? defaultSheetDescription(sheet)),
    tags: normalizeTags(existing?.tags),
    sheetKey: sheet.key,
    path: sheet.path,
    frameWidth: sheet.frameWidth,
    frameHeight: sheet.frameHeight,
    margin: sheet.margin,
    spacing: sheet.spacing,
    cols: sheet.cols,
  };
}

function buildSpriteEntry(
  sprite: SpriteDef,
  existing: SpriteCatalogEntry | undefined,
  cols: number,
): SpriteCatalogEntry {
  return {
    id: `sprite:${sprite.id}`,
    kind: 'sprite',
    label: sprite.id,
    description: ensureSentence(existing?.description ?? defaultSpriteDescription(sprite)),
    tags: normalizeTags(existing?.tags),
    spriteId: sprite.id,
    sheetKey: sprite.sheetKey,
    frame: sprite.frame,
    col: sprite.frame % cols,
    row: Math.floor(sprite.frame / cols),
    note: sprite.note,
    tile: existing?.tile ? { connectsTo: normalizeTags(existing.tile.connectsTo) } : undefined,
    animation: existing?.animation ? { clips: normalizeTags(existing.animation.clips) } : undefined,
  };
}

function normalizeCatalog(raw: unknown): SpriteCatalog {
  return parseSpriteCatalog(raw);
}

export function syncCatalog(
  existingRaw: unknown,
  sheets: readonly SpriteSheetDef[],
  sprites: readonly SpriteDef[],
  options?: { prune?: boolean },
): SpriteCatalog {
  const existing = normalizeCatalog(existingRaw);
  const byId = new Map(existing.map((entry) => [entry.id, entry]));
  const next: SpriteCatalogRecord[] = [];

  for (const sheet of sheets) {
    const existingEntry = byId.get(`sheet:${sheet.key}`);
    const normalizedExisting =
      existingEntry && existingEntry.kind === 'sheet' ? existingEntry : undefined;
    next.push(buildSheetEntry(sheet, normalizedExisting));
  }

  const sheetCols = new Map(sheets.map((sheet) => [sheet.key, sheet.cols]));
  for (const sprite of sprites) {
    const existingEntry = byId.get(`sprite:${sprite.id}`);
    const normalizedExisting =
      existingEntry && existingEntry.kind === 'sprite' ? existingEntry : undefined;
    const cols = sheetCols.get(sprite.sheetKey);
    if (!cols) {
      throw new Error(
        `Cannot sync sprite "${sprite.id}" because sheet "${sprite.sheetKey}" is missing.`,
      );
    }
    next.push(buildSpriteEntry(sprite, normalizedExisting, cols));
  }

  if (!options?.prune) {
    for (const entry of existing) {
      // `generated:` rows are never committed to the catalog — they are derived
      // at read-time from the per-asset manifest shards (see
      // src/shared/generated-catalog.ts). Drop any that leaked in so sync never
      // re-persists a generated duplicate (enforced separately by CI).
      if (isGeneratedCatalogId(entry.id)) {
        continue;
      }
      if (next.find((candidate) => candidate.id === entry.id)) {
        continue;
      }
      next.push(entry);
    }
  }

  next.sort((left, right) => {
    const kindCompare = kindOrder(left.kind) - kindOrder(right.kind);
    if (kindCompare !== 0) return kindCompare;
    return left.id.localeCompare(right.id);
  });

  return parseSpriteCatalog(next);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const outputPath = resolve(args.outPath);
  const exists = existsSync(outputPath);
  const rawExisting = exists ? JSON.parse(readFileSync(outputPath, 'utf-8')) : [];
  const next = syncCatalog(rawExisting, SHEETS, SPRITES, { prune: args.prune });

  // Compare against the Prettier-formatted representation so the check and
  // write paths both use the same canonical output format.
  const nextJson = await formatCatalogJsonToString(outputPath, next);
  const currentJson = exists ? readFileSync(outputPath, 'utf-8') : '';
  const changed = nextJson !== currentJson;

  if (args.check) {
    if (changed) {
      throw new Error(`Sprite catalog is out of sync: ${args.outPath}`);
    }
    process.stdout.write(`Sprite catalog is in sync: ${args.outPath}\n`);
    return;
  }

  if (!changed) {
    process.stdout.write(`No catalog changes needed: ${args.outPath}\n`);
    return;
  }

  await writeCatalogJson(outputPath, next);
  process.stdout.write(`Updated sprite catalog: ${args.outPath}\n`);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  void main();
}
