/** Type declarations for the plain-ESM handoff retrieval helper. */

export const DEFAULT_OUTPUT_BUDGET: number;

export interface HandoffIndexEntry {
  date: string;
  path: string;
  system: string;
  summary: string;
}

export interface HandoffResult extends HandoffIndexEntry {
  score: number;
  excerpt: string;
}

export function parseIndex(index: string): HandoffIndexEntry[];

export function retrieveHandoffs(
  index: string,
  query: string,
  contents: ReadonlyMap<string, string>,
): HandoffResult[];

export function renderHandoffResults(
  query: string,
  results: readonly HandoffResult[],
  budget?: number,
): string;
