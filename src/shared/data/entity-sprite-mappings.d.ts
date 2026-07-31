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
          readonly scale: number;
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
