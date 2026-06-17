/**
 * Run artifact layout + writers for the sprite generation pipeline.
 *
 * Every invocation of `generateOne` (or its CLI front-end) produces a
 * directory of artifacts under `generated/runs/<brief-name>/<run-id>/`. The
 * directory layout is the contract between the orchestrator, the CLI's
 * `--pick` flag, and a future Phase 3 lab/UI:
 *
 *   generated/runs/<brief-name>/<run-id>/
 *     run.json               -- metadata: brief id, prompt hash, timestamp, attempt count
 *     sheet-00.png           -- raw multi-variant sheet from the provider (one per attempt)
 *     raw/NN.png             -- raw N-th slice, before postprocessing
 *     processed/NN.png       -- post-processed native-size PNG (typically 64x64)
 *     processed/NN.scorecard.json  -- sensor scorecard for processed/NN.png
 *     processed/NN.anchor.json     -- derived anchor sidecar (only when the brief opts
 *                                     into sensors.anchor.derive and derivation succeeded)
 *     summary.json           -- ranked candidates: passed-first, then by sensor score
 *     selection.json         -- written ONLY when the user runs `sprites:run --pick N`
 *
 * Run IDs are timestamp + short hash so two runs of the same brief are easy
 * to compare and don't collide. The orchestrator is impure (network + IO)
 * so the clock is fine to use here.
 *
 * Symlinks are deliberately NOT used because Windows symlink support is
 * inconsistent. The CLI writes a small JSON manifest instead.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildAnchorOverlay } from './anchor-overlay.js';
/**
 * Compose the path structure for a run. Pure given (root, brief, runId).
 */
export function runPaths(root, brief, runId) {
  const briefDir = path.join(root, 'runs', brief.name, runId);
  return {
    root,
    runId,
    briefDir,
    rawDir: path.join(briefDir, 'raw'),
    processedDir: path.join(briefDir, 'processed'),
  };
}
/** Pure run-id builder. Caller supplies `now` and the prompt so tests are deterministic. */
export function makeRunId(now, prompt) {
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const hash = createHash('sha256').update(prompt).digest('hex').slice(0, 8);
  return `${ts}-${hash}`;
}
/** Create the run directory tree. Impure. */
export function ensureRunDirs(paths) {
  mkdirSync(paths.briefDir, { recursive: true });
  mkdirSync(paths.rawDir, { recursive: true });
  mkdirSync(paths.processedDir, { recursive: true });
}
/** Write the raw multi-variant sheet PNG for a given attempt index. */
export function writeSheet(paths, attemptIndex, sheet) {
  const file = path.join(paths.briefDir, `sheet-${String(attemptIndex).padStart(2, '0')}.png`);
  writeFileSync(file, sheet);
  return file;
}
/** Write one variant's raw + processed PNGs and its scorecard. Returns paths. */
export function writeVariant(paths, index, raw, processed, scorecard, options = {}) {
  const id = String(index).padStart(2, '0');
  const rawPath = path.join(paths.rawDir, `${id}.png`);
  const processedPath = path.join(paths.processedDir, `${id}.png`);
  const scorecardPath = path.join(paths.processedDir, `${id}.scorecard.json`);
  writeFileSync(rawPath, raw);
  writeFileSync(processedPath, processed);
  writeFileSync(scorecardPath, `${JSON.stringify(scorecard, null, 2)}\n`);
  let anchorSidecarPath = null;
  if (scorecard.derivedAnchors.hold) {
    anchorSidecarPath = path.join(paths.processedDir, `${id}.anchor.json`);
    const sidecar = {
      x: scorecard.derivedAnchors.hold.x,
      y: scorecard.derivedAnchors.hold.y,
      source: 'derived',
    };
    writeFileSync(anchorSidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  }
  let centerOfGravitySidecarPath = null;
  if (scorecard.derivedAnchors.centerOfGravity) {
    centerOfGravitySidecarPath = path.join(paths.processedDir, `${id}.anchor.cog.json`);
    const cogSidecar = {
      x: scorecard.derivedAnchors.centerOfGravity.x,
      y: scorecard.derivedAnchors.centerOfGravity.y,
      source: 'derived',
    };
    writeFileSync(centerOfGravitySidecarPath, `${JSON.stringify(cogSidecar, null, 2)}\n`);
  }
  // Always emit the overlay PNG, even when the anchor is null. A consistent
  // file-per-variant means the gallery can blindly `<img>` it next to the
  // sprite without branching on whether derivation succeeded; null-anchor
  // overlays are fully transparent and so render as a no-op.
  const overlaySize = options.overlaySize ?? { width: 64, height: 64 };
  const anchorOverlayPath = path.join(paths.processedDir, `${id}.anchor-overlay.png`);
  const overlayPng = buildAnchorOverlay({
    width: overlaySize.width,
    height: overlaySize.height,
    anchor: scorecard.derivedAnchor
      ? { x: scorecard.derivedAnchor.x, y: scorecard.derivedAnchor.y }
      : null,
  });
  writeFileSync(anchorOverlayPath, overlayPng);
  return {
    rawPath,
    processedPath,
    scorecardPath,
    anchorSidecarPath,
    centerOfGravitySidecarPath,
    anchorOverlayPath,
  };
}
/** Write run summary JSON. Returns path. */
export function writeSummary(paths, summary) {
  const file = path.join(paths.briefDir, 'summary.json');
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  return file;
}
/**
 * Rank candidates with the combined sensor + judge pipeline gate.
 *
 * Three buckets, in priority order:
 *   1. Sensor passed AND combined pipeline passed                  — full pass
 *   2. Sensor passed, combined pipeline failed                     — includes
 *      both judge-failed variants AND sensor-passed-but-not-judged
 *      variants (e.g. `judgeSkipReason: 'over-cap'`). These are
 *      "sensor-good but the full pipeline didn't clear them" and
 *      must rank below bucket 1 so over-cap entries can't sneak
 *      ahead of variants that actually passed the judge gate.
 *   3. Sensor failed (judge never runs on these)                   — reject pile
 *
 * Within bucket 1 (when judge ran), tie on judge `minScore` desc, then
 * sensor score desc, then index asc. Within bucket 1 (judge disabled)
 * and within the other buckets, tie on sensor score desc, then index asc.
 *
 * Pure.
 */
export function rankCandidates(entries) {
  function bucket(e) {
    if (!e.passed) return 2;
    // Use combinedPassed as the source of truth. Sensor-passed-but-not-judged
    // entries (e.g. judgeSkipReason: 'over-cap') have combinedPassed=false
    // when judging is enabled, so they correctly fall into bucket 1 instead
    // of jumping ahead of variants that actually passed the judge gate.
    if (e.combinedPassed) return 0;
    return 1;
  }
  return [...entries].sort((a, b) => {
    const ba = bucket(a);
    const bb = bucket(b);
    if (ba !== bb) return ba - bb;
    // Same bucket: prefer higher judge minScore when both have one.
    const ja = a.judgeScorecard?.minScore;
    const jb = b.judgeScorecard?.minScore;
    if (ja !== undefined && jb !== undefined && ja !== jb) return jb - ja;
    if (a.score !== b.score) return b.score - a.score;
    return a.index - b.index;
  });
}
/**
 * Pick the top-ranked candidate and resolve its anchor:
 *   - In legacy mode (brief did not opt into `sensors.anchor.derive`), the
 *     static `brief.anchor` pixel applies to every variant.
 *   - In derive mode, only a `derivedAnchor` from the variant is a valid
 *     anchor — `brief.anchor` is informational and must not be surfaced.
 *     If derivation failed for the top variant, `anchor` is null so
 *     downstream consumers see the failure instead of a wrong static value.
 *
 * Returns null when `ranked` is empty. Pure.
 *
 * Note: the chosen candidate's `passed` field reflects the SENSOR scorecard
 * only, for backwards compatibility with consumers that pre-date the judge.
 * The combined sensor+judge pipeline-pass for the chosen variant is carried
 * on `chosen.combinedPassed` (mirrored from the underlying entry). Do NOT
 * derive it from `passed && (judgeScorecard?.passed ?? true)` — that
 * formula wrongly treats sensor-passing-but-not-judged variants
 * (`judgeSkipReason: 'over-cap'`) as full pipeline passes. The ranking
 * already puts combined-passing variants first, so when ANY variant
 * passed the full pipeline, `chosen` will be that variant.
 */
export function pickChosen(ranked, brief) {
  const top = ranked[0];
  if (!top) return null;
  const deriveMode = brief.sensors.anchor?.derive === true;
  const resolvedHold = top.derivedAnchors.hold ?? top.derivedAnchor;
  const holdAnchor = resolvedHold
    ? { x: resolvedHold.x, y: resolvedHold.y, source: 'derived' }
    : deriveMode
      ? null
      : { x: brief.anchor.x, y: brief.anchor.y, source: 'brief' };
  const centerOfGravityAnchor = top.derivedAnchors.centerOfGravity
    ? {
        x: top.derivedAnchors.centerOfGravity.x,
        y: top.derivedAnchors.centerOfGravity.y,
        source: 'derived',
      }
    : holdAnchor
      ? { x: holdAnchor.x, y: holdAnchor.y, source: holdAnchor.source }
      : null;
  return {
    index: top.index,
    score: top.score,
    outOf: top.outOf,
    passed: top.passed,
    anchor: holdAnchor,
    anchors: {
      hold: holdAnchor,
      centerOfGravity: centerOfGravityAnchor,
    },
    judgeScorecard: top.judgeScorecard,
    combinedPassed: top.combinedPassed,
  };
}
//# sourceMappingURL=run-artifacts.js.map
