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
  export function measureCropCrispness(input: {
    pixels: Uint8Array;
    width: number;
    height: number;
  }): { score: number; strongEdges: number; softEdges: number; sampledEdges: number };
  export function evaluateTextRasterRuns(
    runs: unknown[],
    options?: { minimumCrispness?: number },
  ): {
    schemaVersion: number;
    minimumCrispness: number;
    passed: boolean;
    entries: Array<{
      id: string;
      text: string;
      fontFamily: string;
      loaded: boolean;
      aligned: boolean;
      crispness: number | null;
      sampledEdges: number;
      failures: string[];
      pass: boolean;
    }>;
    failures: string[];
  };
  export function suppressUnsupportedFuzziness(result: object, report: { passed: boolean }): number;
}
