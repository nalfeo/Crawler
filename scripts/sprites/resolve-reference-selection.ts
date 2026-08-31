import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import type { SpriteType } from '../../src/shared/sprite-types.js';
import {
  readPendingDislikedSpriteNames,
  resolvePendingAnnotationsPath,
} from '../../.github/extensions/sprite-editor/lib/pending-annotation-overlay.mjs';
import {
  loadAnnotationSpritesMap,
  loadDislikedSpriteNamesFromAnnotations,
} from './reference-annotations.js';
import { isSafeGeneratedAssetPath } from './generated-asset-path.js';
import { loadGeneratedManifest } from './generated-shards.js';
import {
  listEligibleReferences,
  REFERENCE_COUNT,
  referenceSelectorSeed,
  selectReferences,
  type ReferenceSelection,
} from './reference-selector.js';

export interface ResolveReferenceSelectionOptions {
  readonly repoRoot: string;
  readonly briefName: string;
  readonly briefType: SpriteType;
  readonly count?: number;
  readonly manifestPath?: string;
  readonly loadCandidates?: () => readonly ManifestEntry[];
  readonly loadDislikedNames?: () => ReadonlySet<string>;
  readonly loadPendingDislikedNames?: () => ReadonlySet<string>;
  readonly assetExists?: (absolutePath: string) => boolean;
}

export interface ResolvedReferenceSelection {
  readonly selection: ReferenceSelection;
  readonly eligibleCandidates: readonly ManifestEntry[];
  readonly presentCandidateCount: number;
  readonly publicAssetsRoot: string;
}

export function resolveReferenceSelection(
  options: ResolveReferenceSelectionOptions,
): ResolvedReferenceSelection {
  const publicAssetsRoot = path.resolve(options.repoRoot, 'public', 'assets');
  const manifestPath =
    options.manifestPath ?? path.join(publicAssetsRoot, 'generated', 'manifest.json');
  const loadCandidates =
    options.loadCandidates ??
    (() => Object.values(loadGeneratedManifest(path.dirname(manifestPath)).entries));
  const annotationsPath = path.join(
    publicAssetsRoot,
    'generated',
    'sprite-editor-annotations.json',
  );
  const loadDislikedNames =
    options.loadDislikedNames ??
    (() =>
      existsSync(annotationsPath)
        ? loadDislikedSpriteNamesFromAnnotations(annotationsPath)
        : new Set<string>());
  const loadPendingDislikedNames =
    options.loadPendingDislikedNames ??
    (() => {
      const currentSprites = existsSync(annotationsPath)
        ? loadAnnotationSpritesMap(annotationsPath)
        : {};
      return readPendingDislikedSpriteNames(resolvePendingAnnotationsPath(options.repoRoot), {
        getCurrentAnnotation: (key) =>
          Object.hasOwn(currentSprites, key) ? currentSprites[key] : null,
      });
    });
  const assetExists = options.assetExists ?? existsSync;
  const dislikedNames = new Set([...loadDislikedNames(), ...loadPendingDislikedNames()]);
  const presentCandidates = loadCandidates().filter(
    (entry) =>
      isSafeGeneratedAssetPath(entry.assetPath) &&
      assetExists(path.resolve(publicAssetsRoot, entry.assetPath)),
  );
  return {
    selection: selectReferences({
      candidates: presentCandidates,
      briefName: options.briefName,
      briefType: options.briefType,
      count: options.count ?? REFERENCE_COUNT,
      seed: referenceSelectorSeed(options.briefName),
      dislikedSpriteNames: dislikedNames,
    }),
    eligibleCandidates: listEligibleReferences(presentCandidates, options.briefName, dislikedNames),
    presentCandidateCount: presentCandidates.length,
    publicAssetsRoot,
  };
}
