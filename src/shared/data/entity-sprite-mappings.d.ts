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
}
