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
        };
      }
    >
  >;
}
