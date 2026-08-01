export interface CorpusDocument {
  readonly id: string;
  readonly label: string;
  readonly tags: string[];
  readonly type: string;
  readonly description: string;
  readonly briefText: string;
  readonly assetPath: string;
  readonly briefId: string;
}

export function buildCorpus(): CorpusDocument[];
