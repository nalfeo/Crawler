export interface EntitySpriteMappings {
  readonly enemies: Readonly<
    Record<
      string,
      {
        readonly textureId: number;
        readonly description: string;
      }
    >
  >;
  readonly renderKinds: Readonly<
    Record<
      string,
      {
        readonly proceduralTexture: string;
        readonly kenneySpriteId?: string;
        readonly kenneyScale?: number;
        readonly generated?: {
          readonly briefId: string;
          readonly pinnedTextureKey: string;
          /**
           * LEGACY raw multiplier applied to the source art's pixel size.
           *
           * Only used when {@link heightFt} is absent, or when the renderer
           * cannot measure the loaded texture (headless/stub scenes). A raw
           * multiplier silently couples on-screen size to the asset
           * pipeline's canvas size: when the enemy brief default grew from
           * 64×64 to 256×256 (and 512×512 for `sizeVariant: large` bosses),
           * every mob resolved through this factor rendered 4–8× oversized.
           * Prefer `heightFt` for anything new.
           */
          readonly scale: number;
          /**
           * Authored target footprint: the drawn HEIGHT of the sprite's
           * VISIBLE art, in world feet.
           *
           * When present the renderer derives the base scale as
           * `ftToPx(heightFt) / opaqueHeightPx`, so on-screen size is a
           * property of the game world rather than of whatever canvas the
           * sprite pipeline happened to emit. Measured against the manifest's
           * `opaqueBounds` (not the raw canvas) so the pipeline's ~5%-per-side
           * transparent safety margin does not shrink the art.
           *
           * Deliberately absent for `player`: that render kind is backed by a
           * multi-frame walk-cycle SHEET whose `opaqueBounds` describe the
           * whole strip, not one frame, so a height fit would be measured
           * against the wrong rectangle. It stays on the pixel-based `scale`,
           * which `tests/unit/player-npc-scale-parity.test.ts` pins to the
           * welcome-room NPC height.
           */
          readonly heightFt?: number;
          /**
           * Per-appearance-key override of the generated descriptor, checked
           * BEFORE the top-level `briefId`/`pinnedTextureKey`/`scale` above.
           * Used by the player render kind to select one of several
           * gender-matched walk-cycle sheets at runtime
           * (`appearanceKey === world.playerGender`); the top-level fields
           * remain the default used when the resolved `appearanceKey` has no
           * entry here (belt-and-suspenders — should not happen for a
           * `'female' | 'male' | 'other'` key, but keeps the fallback cascade
           * intact for any future unmapped key).
           */
          readonly variantsByAppearanceKey?: Readonly<
            Record<
              string,
              {
                readonly briefId: string;
                readonly pinnedTextureKey: string;
                readonly scale?: number;
              }
            >
          >;
        };
      }
    >
  >;
}
