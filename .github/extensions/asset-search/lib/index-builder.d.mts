export interface AssetSearchDocument {
  readonly id: string;
  readonly label: string;
  readonly tags: readonly string[];
  readonly type: string;
  readonly description: string;
  readonly briefText: string;
  readonly assetPath: string;
  readonly briefId: string;
}

export function buildCorpus(): AssetSearchDocument[];
