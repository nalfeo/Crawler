export function buildArtDirectionPrompt(scenario: Record<string, unknown>): {
  system: string;
  user: string;
};
export function discoverEquipmentCaptures(root: string): Array<{ version: string; image: string }>;
export function neutralEquipmentScenario(version: string): Record<string, unknown>;
export function normalizeArtDirectionReview(
  raw: unknown,
  options: {
    image: string;
    scenario: Record<string, unknown>;
    modelDeployment: string;
  },
): Record<string, unknown>;
export function summarizeArtDirectionReviews(reviews: Array<Record<string, unknown>>): {
  total: number;
  completed: number;
  failed: number;
  repeatedBiggestProblems: Array<{ diagnosis: string; count: number }>;
};
