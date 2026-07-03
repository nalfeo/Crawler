/**
 * Resolve the reference PNG buffers a stored run was generated against, from
 * the run summary's recorded `referenceSprites` selection.
 *
 * The GENERATE stage records exactly which of our approved generated sprites it
 * sent to the image provider (see `reference-selector.ts` + the `referenceSprites`
 * field on `RunSummary`). Re-judging must score the variants against the SAME
 * references — references take precedence in the judge prompt — so this loader
 * replays the recorded selection rather than re-loading `brief.references`
 * (which pointed at the now-retired Kenney placeholder spritesheets).
 *
 * Reproducibility guard: when a recorded reference carries a `contentHash`, the
 * on-disk bytes are re-hashed and MUST match. Approving a new asset can reuse a
 * path (`approve.ts`), so a silent byte drift would otherwise re-judge against
 * different pixels than the run was generated with. On mismatch — or a missing
 * asset, or a summary with no recorded selection (legacy pre-retirement runs) —
 * this throws with an actionable message telling the operator to re-generate.
 * It never falls back to Kenney.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { RunSummary } from './run-artifacts.js';

export interface LoadRecordedReferencePngsOptions {
  /** The stored run summary whose `referenceSprites` selection to replay. */
  readonly summary: Pick<RunSummary, 'brief' | 'referenceSprites'>;
  /** Repository root; asset paths resolve under `<repoRoot>/public/assets/`. */
  readonly repoRoot: string;
  /** Byte reader injection (tests). Defaults to `fs.readFileSync`. */
  readonly readReference?: (absolutePath: string) => Buffer;
  /** Existence-check injection (tests). Defaults to `fs.existsSync`. */
  readonly assetExists?: (absolutePath: string) => boolean;
  /** Content hasher injection (tests). Defaults to SHA-256 hex. */
  readonly hashBytes?: (bytes: Buffer) => string;
}

/**
 * Load the exact reference PNG bytes recorded for a run. Impure (filesystem).
 * Throws loudly on any inconsistency; never returns Kenney placeholders.
 */
export function loadRecordedReferencePngs(options: LoadRecordedReferencePngsOptions): Buffer[] {
  const { summary, repoRoot } = options;
  const readReference = options.readReference ?? ((p) => readFileSync(p));
  const assetExists = options.assetExists ?? ((p) => existsSync(p));
  const hashBytes =
    options.hashBytes ?? ((bytes) => createHash('sha256').update(bytes).digest('hex'));

  const selection = summary.referenceSprites;
  if (!selection || selection.selected.length === 0) {
    throw new Error(
      `loadRecordedReferencePngs: run "${summary.brief}" has no recorded referenceSprites. ` +
        `This run predates the Kenney-reference retirement and cannot be re-judged on-style — ` +
        `re-generate it so the current reference selector records its picks.`,
    );
  }

  const publicAssetsRoot = path.resolve(repoRoot, 'public', 'assets');
  return selection.selected.map((ref) => {
    const absolutePath = path.resolve(publicAssetsRoot, ref.assetPath);
    if (!assetExists(absolutePath)) {
      throw new Error(
        `loadRecordedReferencePngs: recorded reference "${ref.spriteName}" (${ref.assetPath}) ` +
          `is missing on disk for run "${summary.brief}". The approved asset was moved or ` +
          `deleted since this run was generated — re-generate rather than re-judging.`,
      );
    }
    const bytes = readReference(absolutePath);
    if (ref.contentHash !== null) {
      const actual = hashBytes(bytes);
      if (actual !== ref.contentHash) {
        throw new Error(
          `loadRecordedReferencePngs: recorded reference "${ref.spriteName}" (${ref.assetPath}) ` +
            `content hash drifted for run "${summary.brief}" (expected ${ref.contentHash}, got ` +
            `${actual}). The approved asset changed since this run was generated — re-generate ` +
            `rather than re-judging against different bytes.`,
        );
      }
    }
    return bytes;
  });
}
