import type { RunBundle, RunBundleMeta } from './run-bundle.js';
import { serializePlaytestSurvey, type PlaytestSurvey } from './playtest-survey.js';

/**
 * Pure request-shape builders for the PR2 `/runs` ingest contract. Every field
 * here is normalized data with no network/global-runtime dependency — endpoint
 * resolution and fetch/beacon delivery live in `src/engine/run-bundle-upload.ts`.
 */
export interface RunBundleUploadRequest {
  readonly runStats: unknown;
  readonly recorderJsonl: string;
  readonly logs: readonly string[];
  readonly meta: RunBundleMeta;
  readonly survey?: PlaytestSurvey;
}

export function buildRunBundleUploadRequest(bundle: RunBundle): RunBundleUploadRequest {
  return {
    runStats: bundle.runStats,
    recorderJsonl: bundle.recorderJsonl,
    logs: bundle.logs,
    meta: bundle.meta,
  };
}

export function buildRunSurveyRequest(
  bundle: RunBundle,
  survey: PlaytestSurvey,
): RunBundleUploadRequest {
  return {
    ...buildRunBundleUploadRequest(bundle),
    survey: serializePlaytestSurvey(survey),
  };
}
