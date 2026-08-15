declare module '*.mjs' {
  export const REVIEW_AXES: readonly string[];
  export function mediaTypeFor(path: string): 'image/png' | 'image/jpeg' | 'image/webp';
  export function parseArgs(argv: string[]): {
    image: string;
    metadata?: string;
    output?: string;
    minScore: number | null;
    minCoverage: number | null;
  };
  export function parseMetadataText(text: string): Record<string, unknown>;
  export function buildPrompt(metadata: Record<string, unknown>): {
    system: string;
    user: string;
  };
  export function normalizeReview(
    raw: unknown,
    options: {
      image: string;
      metadata: Record<string, unknown>;
      modelDeployment: string;
    },
  ): {
    score: number;
    coverage: number;
    hardFailures: string[];
    [key: string]: unknown;
  };
  export function assertAdvisoryThresholds(
    result: { score: number; coverage: number },
    thresholds: { minScore: number | null; minCoverage: number | null },
  ): void;
}
