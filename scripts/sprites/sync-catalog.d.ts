import { type SpriteDef, type SpriteSheetDef } from '../../src/engine/sprites/index.js';
import { type SpriteCatalog } from '../../src/shared/sprite-catalog.js';
export declare function syncCatalog(
  existingRaw: unknown,
  sheets: readonly SpriteSheetDef[],
  sprites: readonly SpriteDef[],
  options?: {
    prune?: boolean;
  },
): SpriteCatalog;
//# sourceMappingURL=sync-catalog.d.ts.map
