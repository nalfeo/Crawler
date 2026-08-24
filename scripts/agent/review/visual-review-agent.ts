#!/usr/bin/env tsx
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import type { Page } from 'playwright';
import { PNG } from 'pngjs';
import { AzureOpenAIVisionProvider } from '../../sprites/provider/azure-vision.js';
import {
  evaluateTextRasterRuns,
  measureCropCrispness,
  suppressUnsupportedFuzziness,
  toScreenshotRasterGeometry,
} from './text-raster-lib.mjs';
import {
  computeGeometryBlockers,
  deriveAnchoredScore,
  diffFindings,
  findingKeys,
  lacksPixelGroundedGeometry,
  suppressUnsupportedAlignment,
  DETERMINISTIC_BLOCKER_PENALTY,
  LLM_BLOCKER_PENALTY,
} from './visual-review-lib.mjs';
import type { VisualReviewBox, VisualReviewRegion } from './visual-review-lib.mjs';
import {
  DEFAULT_LEDGER_NOTE,
  findingTextReferencesSuppressedAsset,
  mergeAssetFindingsIntoLedger,
  normalizeAssetKey,
  parseArtLedger,
  suppressedAssetKeys,
} from './art-ledger.js';
import type { ArtLedger, ArtLedgerEntry } from './art-ledger.js';

export interface CliOptions {
  labUrl: string;
  outputDir: string;
  minScore: number;
  uxName: string;
  uxGoal: string;
  setupFile: string | null;
  skipProbeWait: boolean;
  /**
   * How long to wait for the surface's readiness probe. The default suits DOM/UI
   * surfaces, but an engine-backed surface on a cold Playwright profile has to
   * fetch and decode the whole generated-sprite set before it reports ready, so
   * heavy surfaces (e.g. the set-piece lab) need to raise this.
   */
  probeTimeoutMs: number;
  screenshotName: string;
  viewportWidth: number;
  viewportHeight: number;
  waitMs: number;
  viewport: { width: number; height: number };
  clip: { x: number; y: number; width: number; height: number } | null;
  /**
   * Author rebuttals to prior findings, each a self-contained line. Injected
   * into the prompt so the judge must reconcile them against the measured
   * geometry and issue a FINAL verdict (defend with numbers or withdraw).
   */
  rebuttals: string[];
  /**
   * Art-review mode (opt-in). When set, the prompt gains an ASSET INTEGRITY
   * critique block (stretched/wrong-aspect, semantic mismatch, wall-fixture-on-
   * floor, wrong orientation, clipped) + an `asset_findings` schema field, the
   * agent reads/writes an art-regen ledger (suppress-list of known-bad art), and
   * it stores a labeled GOOD/BAD evidence corpus. Off by default so DOM-panel
   * surfaces (equipment/inventory) keep their exact prior prompt + output.
   */
  artReview: boolean;
  /** Path to the art-regen ledger JSON (art-review mode). Defaults under outputDir. */
  artLedger: string | null;
  /** Root dir for the labeled evidence corpus (art-review mode). Defaults under outputDir. */
  evidenceDir: string | null;
  /**
   * Deterministic A|B iteration lineage capture (opt-in). When `lineageScenario`
   * is set, this run is an explicit iteration step in a tracked A|B comparison
   * (not a one-off speculative screenshot): in addition to the usual timestamped
   * raw capture, the screenshot + review are ALSO copied into
   * `outputDir/<lineageSide>/<lineageState>/<lineageScenario>.png` (and
   * `.review.json`), which is the exact filename/state contract the Screenshot
   * Viewer's `pairs()` lineage grouping requires. This removes the manual
   * copy/rename step that has twice caused broken lineage chains (missing
   * iterations never copied in, and a filename mismatch that orphaned a state
   * from its lineage). Omit these flags for a speculative/exploratory capture
   * that should NOT be tracked as a scored iteration step.
   */
  lineageScenario: string | null;
  /** Lineage state label, e.g. "main", "v1", "v2". Required when lineageScenario is set. */
  lineageState: string | null;
  /** Which side of the lineage this capture belongs to. Defaults to "after". */
  lineageSide: 'before' | 'after';
}

type ScreenClip = { x: number; y: number; width: number; height: number };

interface VisualAxis {
  score: number;
  strengths?: string[];
  issues?: string[];
}

interface PreciseFix {
  element: string;
  action: string;
  dx?: number;
  dy?: number;
  dw?: number;
  dh?: number;
  reason?: string;
}

/** Defect class for an art-asset-level finding. */
type AssetDefectKind =
  | 'stretched'
  | 'oversized'
  | 'semantic-mismatch'
  | 'misplaced-fixture'
  | 'wrong-orientation'
  | 'clipped'
  | 'other';

/**
 * An art-asset-level defect (art-review mode) — a problem with the generated
 * sprite pixels or how the fixture reads, distinct from a layout/data defect.
 * `needs_regen === true` means only regenerating/replacing the source art can
 * fix it, so it feeds the art-regen ledger (and is then suppressed next run).
 */
interface AssetFinding {
  asset: string;
  prop?: string;
  kind?: AssetDefectKind;
  issue?: string;
  needs_regen?: boolean;
}

/** A per-element crop captured in screenshot space for the evidence corpus. */
interface EvidenceRegionShot {
  id: string;
  kind: string;
  box: { x: number; y: number; width: number; height: number };
  /** Absolute path to the (unlabeled) crop PNG, or null if off-screen / too small. */
  cropPath: string | null;
}

interface VisualReviewResult {
  overall?: {
    score?: number;
    /** Headline number the MODEL returned, kept only for provenance — it is anchored noise. */
    raw_score?: unknown;
    verdict?: string;
    summary?: string;
  };
  /** How `overall.score` was derived from axes + findings, so a reader can audit it. */
  score_derivation?: {
    axis_mean: number | null;
    penalty: number;
    deterministic_blockers: number;
    llm_blockers: number;
    model_reported_score: number;
  };
  axes?: Record<string, VisualAxis>;
  blocking_findings?: string[];
  recommended_fixes?: string[];
  precise_fixes?: PreciseFix[];
  deterministic_blocking_findings?: string[];
  geometry?: GeometrySnapshot;
  /** Which harvest path produced the geometry: declared surface, legacy equipment, or none. */
  harvest_source?: HarvestSource;
  /** Optional surface label declared via `window.__visualReview.surface`. */
  surface?: string;
  /** Declared region ids (declared path only) so consumers can map fixes to elements. */
  regions_declared?: string[];
  /** NEW vs RECURRING split of blocking findings against the most recent prior review. */
  finding_trajectory?: { new: string[]; recurring: string[] };
  /** SHA-256 of the captured PNG, so an unchanged "iteration" is detectable after the fact. */
  capture_hash?: string;
  /** True when this capture is byte-identical to the prior one — any score delta is noise. */
  capture_unchanged_from_prior?: boolean;
  /** Art-asset-level defects (art-review mode). Layout defects stay in blocking_findings. */
  asset_findings?: AssetFinding[];
  /** Assets suppressed this run because they are already on the art-regen ledger. */
  suppressed_ledger_assets?: string[];
  /**
   * How many FREE-TEXT findings (blocking_findings / recommended_fixes /
   * precise_fixes) were dropped this run for referencing a suppressed queued asset
   * — the cross-array half of the "don't re-critique queued art" suppression.
   */
  suppressed_text_finding_count?: number;
  /** Assets newly appended to the art-regen ledger by this run. */
  ledger_added?: string[];
  /** Deterministic evidence for text raster sharpness on declared equipment runs. */
  text_raster?: TextRasterReport;
  /** Azure-only fuzzy-text claims suppressed by text-raster evidence. */
  suppressed_text_raster_findings?: number;
  /** Azure-only slot-misalignment claims suppressed by the deterministic grid check. */
  suppressed_alignment_findings?: number;
}

interface TextRasterEntry {
  id: string;
  text: string;
  fontFamily: string;
  rasterX: number | null;
  rasterY: number | null;
  rasterScaleX: number | null;
  rasterScaleY: number | null;
  resolution: number | null;
  loaded: boolean;
  aligned: boolean;
  crispness: number | null;
  sampledEdges: number;
  failures: string[];
  pass: boolean;
}

interface TextRasterReport {
  schemaVersion: number;
  minimumCrispness: number;
  passed: boolean;
  entries: TextRasterEntry[];
  failures: string[];
}

interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface SlotGeometry {
  id: string;
  box: ElementBox | null;
  icon: ElementBox | null;
}

interface GeometrySnapshot {
  panel: ElementBox | null;
  tooltip: ElementBox | null;
  slots: SlotGeometry[];
}

type HarvestSource = 'declared' | 'equipment-legacy' | 'none';

interface LookbookDimension {
  id: string;
  label: string;
  weight: number;
  visibleQuestion: string;
}

interface LookbookRubric {
  source: string;
  dimensions: LookbookDimension[];
  hardFailureCaps: string[];
  constraints: string[];
}

/**
 * Which conditional (surface-specific) hard requirements the prompt should assert.
 * Legacy equipment sets all three true so its prompt matches today's byte-for-byte;
 * generic surfaces opt in only to what they actually have.
 */
interface SurfaceExpectations {
  tooltipAfterHover: boolean;
  statLabelsHumanReadable: boolean;
  sectionDividers: boolean;
}

interface CaptureResult {
  /** Deterministic blockers to merge with the LLM findings (never gated by the LLM). */
  deterministicBlockers: string[];
  /** Legacy equipment geometry snapshot; an empty snapshot for other paths. */
  geometry: GeometrySnapshot;
  /** The text injected into the prompt as MEASURED LAYOUT GEOMETRY. */
  geometryText: string;
  harvestSource: HarvestSource;
  surface: string | null;
  /** Declared regions (declared path only); empty otherwise. */
  regions: VisualReviewRegion[];
  expect: SurfaceExpectations;
  /** Per-element crops for the evidence corpus (art-review mode); empty otherwise. */
  evidenceRegions: EvidenceRegionShot[];
  /** Pixel-grounded text-raster evidence for the legacy equipment surface. */
  textRaster: TextRasterReport | null;
}

const DEFAULT_VIEWPORT = { width: 1600, height: 1000 } as const;

function parseViewport(value: string | undefined): { width: number; height: number } {
  const match = /^([1-9]\d*)x([1-9]\d*)$/i.exec(value ?? '');
  if (!match) {
    throw new Error(`invalid --viewport "${value ?? ''}" (expected positive integer WIDTHxHEIGHT)`);
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new Error(`invalid --viewport "${value}" (dimensions exceed safe integer range)`);
  }
  return { width, height };
}

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    labUrl: 'http://127.0.0.1:4176/lab.html?lab=ui-probe-lab',
    outputDir: resolve(process.cwd(), 'files', 'visual-review'),
    minScore: 80,
    uxName: 'equipment + inventory character panel',
    uxGoal:
      'clear slot layout, readable typography, strong hierarchy, coherent spacing, icon-first item representation',
    setupFile: null,
    skipProbeWait: false,
    probeTimeoutMs: 45_000,
    screenshotName: 'ux-surface',
    viewportWidth: 1600,
    viewportHeight: 1000,
    waitMs: 350,
    viewport: { ...DEFAULT_VIEWPORT },
    clip: null,
    rebuttals: [],
    artReview: false,
    artLedger: null,
    evidenceDir: null,
    lineageScenario: null,
    lineageState: null,
    lineageSide: 'after',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--url' && next) {
      opts.labUrl = next;
      i += 1;
      continue;
    }

    if (arg === '--output-dir' && next) {
      opts.outputDir = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--min-score' && next) {
      const score = Number(next);
      if (!Number.isFinite(score) || score < 0 || score > 100) {
        throw new Error(`invalid --min-score "${next}" (expected 0..100)`);
      }
      opts.minScore = score;
      i += 1;
      continue;
    }
    if (arg === '--ux-name' && next) {
      opts.uxName = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--ux-goal' && next) {
      opts.uxGoal = next.trim();
      i += 1;
      continue;
    }
    if (arg === '--rebuttal' && next) {
      const line = next.trim();
      if (line.length > 0) {
        opts.rebuttals.push(line);
      }
      i += 1;
      continue;
    }
    if (arg === '--art-review') {
      opts.artReview = true;
      continue;
    }
    if (arg === '--art-ledger' && next) {
      opts.artLedger = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--evidence-dir' && next) {
      opts.evidenceDir = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--setup-file' && next) {
      opts.setupFile = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--no-probe-wait') {
      opts.skipProbeWait = true;
      continue;
    }
    if (arg === '--probe-timeout-ms' && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 1_000 || value > 600_000) {
        throw new Error(`invalid ${arg} "${next}" (expected integer 1000..600000)`);
      }
      opts.probeTimeoutMs = value;
      i += 1;
      continue;
    }
    if (arg === '--screenshot-name' && next) {
      opts.screenshotName = next.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
      i += 1;
      continue;
    }
    if (arg === '--lineage-scenario' && next) {
      opts.lineageScenario = next.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
      i += 1;
      continue;
    }
    if (arg === '--lineage-state' && next) {
      // Keep dots so semantic versions (v0.1.0) retain their canonical form.
      opts.lineageState = next
        .trim()
        .replace(/[^a-zA-Z0-9_.-]+/g, '-')
        .replace(/(?:^|-)\.\.(?=-|$)/g, '-')
        .replace(/-{2,}/g, '-');
      i += 1;
      continue;
    }
    if (arg === '--lineage-side' && next) {
      if (next !== 'before' && next !== 'after') {
        throw new Error(`invalid --lineage-side "${next}" (expected "before" or "after")`);
      }
      opts.lineageSide = next;
      i += 1;
      continue;
    }
    if ((arg === '--viewport-width' || arg === '--viewport-height') && next) {
      const value = Number(next);
      if (!Number.isInteger(value) || value < 320 || value > 7680) {
        throw new Error(`invalid ${arg} "${next}" (expected integer 320..7680)`);
      }
      if (arg === '--viewport-width') {
        opts.viewportWidth = value;
        opts.viewport = { ...opts.viewport, width: value };
      } else {
        opts.viewportHeight = value;
        opts.viewport = { ...opts.viewport, height: value };
      }
      i += 1;
      continue;
    }
    if (arg === '--wait-ms' && next) {
      const waitMs = Number(next);
      if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 60_000) {
        throw new Error(`invalid --wait-ms "${next}" (expected 0..60000)`);
      }
      opts.waitMs = waitMs;
      i += 1;
      continue;
    }
    if (arg === '--viewport') {
      opts.viewport = parseViewport(next);
      i += 1;
      continue;
    }
    if (arg === '--clip' && next) {
      const parts = next.split(',').map((part) => Number(part.trim()));
      if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
        throw new Error(
          `invalid --clip "${next}" (expected "x,y,width,height" with non-negative numbers)`,
        );
      }
      const [x, y, width, height] = parts as [number, number, number, number];
      if (width <= 0 || height <= 0) {
        throw new Error(`invalid --clip "${next}" (width/height must be > 0)`);
      }
      opts.clip = { x, y, width, height };
      i += 1;
      continue;
    }
  }
  if (opts.lineageScenario && !opts.lineageState) {
    throw new Error('--lineage-scenario requires --lineage-state (e.g. "live-dev", "v0.1.0")');
  }
  return opts;
}

function normalizeClip(value: unknown): ScreenClip | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<ScreenClip>;
  const x = Number(candidate.x);
  const y = Number(candidate.y);
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    x < 0 ||
    y < 0 ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { x, y, width, height };
}

function readEnvVar(name: string): string {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`missing required env var ${name}`);
  }
  return value.trim();
}

function extractJsonObject(raw: unknown): VisualReviewResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('LLM returned a non-object JSON payload');
  }
  return raw as VisualReviewResult;
}

function nowStamp(): string {
  const iso = new Date().toISOString();
  return iso.replace(/[:.]/g, '-');
}

const INVENTORY_UX_LOOKBOOK_RUBRIC = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('./rpg-inventory-ux-lookbook-rubric.json', import.meta.url)),
    'utf-8',
  ),
) as LookbookRubric;

function formatInventoryLookbookRubric(rubric: LookbookRubric): string {
  const dimensions = rubric.dimensions
    .map((d) => `- ${d.label} (${d.weight}): ${d.visibleQuestion}`)
    .join('\n');
  const caps = rubric.hardFailureCaps.map((cap) => `- ${cap}`).join('\n');
  const constraints = rubric.constraints.map((constraint) => `- ${constraint}`).join('\n');
  return `RPG INVENTORY UX LOOKBOOK REFERENCE (${rubric.source})
Use this when the surface is equipment, inventory, item tooltip, loot triage, or build inspection. Judge the screenshot by the player decision it supports, not by whether the chrome looks polished.

Weighted decision rubric:
${dimensions}

Hard-failure caps:
${caps}

Product constraints to enforce:
${constraints}`;
}

function buildPrompt(
  opts: Pick<CliOptions, 'uxName' | 'uxGoal' | 'rebuttals'>,
  geometryText: string,
  context: {
    expect: SurfaceExpectations;
    regionIds: string[];
    artReview?: boolean;
    ledgerAssets?: ArtLedgerEntry[];
  },
): { system: string; user: string } {
  const rebuttalBlock =
    opts.rebuttals.length > 0
      ? `

AUTHOR REBUTTALS TO PRIOR FINDINGS (the author claims these earlier critiques are FACTUALLY WRONG per the measured geometry above — this is a FINAL reconciliation pass):
${opts.rebuttals.map((r, idx) => `${idx + 1}. ${r}`).join('\n')}

How to handle each rebuttal (do this rigorously, it is the point of this pass):
- Check the claim against the MEASURED LAYOUT GEOMETRY, which is authoritative and exact. The screenshot can mislead you about pixel gaps and alignment; the numbers cannot.
- If the geometry supports the author (e.g. the gap/clearance/alignment they cite is real), you MUST WITHDRAW that finding: do not list it in blocking_findings or precise_fixes, and say "withdrawn: <finding>" in the relevant axis "strengths".
- If you still believe a finding stands, you MUST defend it with the specific pixel numbers from the geometry table (which two element edges, at which coordinates, and the exact overlap/misalignment in px). A finding you cannot ground in the numbers must be withdrawn.
- Do NOT introduce brand-new positional nitpicks below a 3px threshold; sub-3px "misalignment" on 60px-in-64px icons is intended centering inset, not a defect.
- End "overall.summary" with an explicit sentence: "FINAL VERDICT: <pass|needs-work|fail> — <count> findings withdrawn, <count> upheld with pixel evidence."`
      : '';
  const hasDeclaredHoverTarget = context.regionIds.some((id) => id.startsWith('hover-target:'));
  // UNIVERSAL readability/affordance rules are always asserted; three CONDITIONAL
  // rules are injected only when the surface opts in via `expect.*`. Legacy equipment
  // sets all three true, so this reproduces today's prompt byte-for-byte.
  const readabilityLines = [
    'Readability and affordance standards are strict:',
    '- Pixel-font text must look crisp (no blurry/soft downscaled look).',
    ...(context.expect.statLabelsHumanReadable
      ? [
          '- Stat labels must be human-readable words (e.g., "CRIT CHANCE"), not raw camelCase/PascalCase identifiers.',
        ]
      : []),
    ...(context.expect.tooltipAfterHover
      ? [
          '- Empty slots must expose slot identity/help affordance (in this capture an empty-slot tooltip should be visible).',
        ]
      : []),
    ...(hasDeclaredHoverTarget
      ? [
          '- This is an item-hover capture. The declared hover target must contain real equipment, have a visible emphasis outline, and retain a nearby tooltip that does not cover it.',
        ]
      : []),
    '- Slot tiles should be roughly square or portrait; very short/wide slot boxes are a defect.',
    '- Slot tiles must have visible breathing room; touching box edges between neighbors is a defect.',
    '- Sprites should occupy most of slot interior; large dead padding around icons is a defect.',
    '- Empty-state cues must be explicit and readable; punctuation placeholders like "?" or "_" are not acceptable primary indicators.',
    ...(context.expect.sectionDividers
      ? [
          '- Section labels (e.g., PRIMARY/SECONDARY) must not have decorative lines crossing through glyphs.',
        ]
      : []),
    '- Tooltip surfaces must render above nearby elements and remain fully readable.',
  ].join('\n');
  const hardRequirementLines = [
    'Hard requirements:',
    '- Name specific concrete defects (exact panel/slot/area) in issues.',
    '- If any overlap, clipping, misalignment, or unreadable text exists, include it in blocking_findings.',
    '- If text appears cramped (insufficient top padding/line breathing room), include it in blocking_findings.',
    ...(context.expect.statLabelsHumanReadable
      ? [
          '- If stat labels appear as code-style camelCase/PascalCase, include it in blocking_findings.',
        ]
      : []),
    '- If text appears blurry/soft rather than crisp pixel text, include it in blocking_findings.',
    ...(context.expect.tooltipAfterHover
      ? [
          '- If empty-slot tooltip affordance is missing/unclear in the capture, include it in blocking_findings.',
        ]
      : []),
    ...(hasDeclaredHoverTarget
      ? [
          '- If the declared hover target is empty, lacks visible emphasis, has no tooltip, or the tooltip covers it, include it in blocking_findings.',
          '- A tooltip behind any panel or item is a hard failure: include it in blocking_findings even if its text is otherwise readable.',
        ]
      : []),
    '- If slot aspect ratio or icon occupancy harms item readability, include it in blocking_findings.',
    '- If slot boxes touch each other with no breathing room, include it in blocking_findings.',
    ...(context.expect.sectionDividers
      ? [
          '- If any section label has line-through/intersecting divider artifacts, include it in blocking_findings.',
        ]
      : []),
    '- If placeholder punctuation is used as the primary empty-slot indicator, include it in blocking_findings.',
    '- If tooltip layering/clipping makes tooltip text hard to read, include it in blocking_findings.',
    '- If visual theming feels generic and not like a pixel dungeon crawler, include it in blocking_findings.',
    '- recommended_fixes must be actionable and ordered by impact.',
  ].join('\n');
  const regionIdsBlock =
    context.regionIds.length > 0
      ? `\n\nDECLARED REGION IDS (reference these EXACT ids in precise_fixes.element and when citing elements): ${context.regionIds.join(', ')}.`
      : '';
  const inventoryLookbookBlock = formatInventoryLookbookRubric(INVENTORY_UX_LOOKBOOK_RUBRIC);
  // ART-REVIEW MODE (opt-in): critique the ART ASSETS themselves, maintain a
  // regen ledger, and suppress already-queued assets. These blocks are EMPTY
  // for non-art surfaces so equipment/inventory prompts stay byte-for-byte.
  const artReview = context.artReview === true;
  const assetIntegrityBlock = artReview
    ? `

ASSET INTEGRITY — judge the ART ASSETS themselves, not just the layout (be HARSH here):
This surface composites generated sprite art into a top-down room diorama. In ADDITION to layout, hunt for defects baked into the art or the way a fixture reads, and report EACH as a blocking finding AND as an entry in "asset_findings":
- STRETCHED / WRONG ASPECT: a sprite visibly squashed or elongated away from natural proportions (e.g. a square motif smeared across a wide footprint). Oddly stretched art is a serious defect — call it out EVERY time you see it, and say which element.
- RELATIVE SCALE / OUT-OF-PROPORTION: an element whose on-screen SIZE is wrong RELATIVE to the people (NPCs) and furniture around it — furniture that dwarfs the human characters, or props (sconces, potions, junk, plants) that are far too big or too small for what they are. Use an NPC's height as the human reference: a reception desk, table, or bookcase should read a bit taller/wider than a person, never several times their size; a wall sconce or potion bottle should read much SMALLER than a person. When something is clearly out of proportion, flag it, name the element, and say whether it is too big or too small versus the NPCs.
- SEMANTIC MISMATCH (asked-vs-got): the rendered art does not depict what the element is supposed to be. Concrete example to watch for: a "welcome BANNER" that is actually a free-standing SIGN and is NOT mounted on the wall. If the intent word (banner, desk, bookcase, rug, sconce, torch, table) disagrees with what you actually SEE, flag it.
- WALL FIXTURE ON THE FLOOR: a fixture that belongs mounted on a wall (sconce, torch, banner, sign, wall shelf) but is drawn sitting on the floor or in open space instead of on/against a wall.
- WRONG ORIENTATION FOR WALL SIDE: a wall fixture whose facing does not match the wall it sits on — a LEFT-wall sconce must face inward (to the right), a RIGHT-wall sconce must face inward (to the left), a BACK-wall fixture faces toward the camera. Mismatched orientation is a defect; name the fixture and the wall it is on.
- CLIPPED / CUT OFF: a sprite whose edges are cut off by the frame, by a neighbor, or by its own footprint box.

For EACH "asset_findings" entry:
- "asset": the element you are judging (use a DECLARED REGION ID above if one matches, e.g. "welcome-banner"; otherwise a short descriptive label like "left wall sconce").
- "kind": one of stretched | oversized | semantic-mismatch | misplaced-fixture | wrong-orientation | clipped | other.
- "needs_regen": true ONLY when the ART PIXELS themselves are wrong so NO reposition/resize in the scene could fix it (wrong subject, baked-in stretch/orientation). false when moving/resizing/re-anchoring the EXISTING sprite would fix it — that is a layout fix, so ALSO keep it in blocking_findings/precise_fixes. RELATIVE-SCALE / oversized findings are almost always needs_regen=false (the scene can resize the sprite).`
    : '';
  const ledgerAssets = artReview ? (context.ledgerAssets ?? []) : [];
  const ledgerSuppressBlock =
    ledgerAssets.length > 0
      ? `

KNOWN ART-REGEN QUEUE (already logged as needing regeneration — do NOT re-critique these):
${ledgerAssets
  .map(
    (e) =>
      `- ${e.asset}${e.prop ? ` (${e.prop})` : ''} — ${e.kind ?? 'defect'}: ${e.issue ?? 'queued for regen'}`,
  )
  .join('\n')}
Treat each listed asset as if it WILL be replaced. Do NOT mention it in any axis "issues", blocking_findings, asset_findings, recommended_fixes, or precise_fixes, and do NOT lower any axis or overall score because of it. Judge everything else normally.`
      : '';
  const assetFindingsSchema = artReview
    ? `,
  "asset_findings": [
    { "asset": string, "prop": string, "kind": "stretched" | "oversized" | "semantic-mismatch" | "misplaced-fixture" | "wrong-orientation" | "clipped" | "other", "issue": string, "needs_regen": boolean }
  ]`
    : '';
  return {
    system: `You are a brutally honest senior game UI art director.
Evaluate ONLY what is visible in the screenshot and output strict JSON.
Do not excuse prototype quality. Call out spacing, overlap, alignment, hierarchy, typography, icon usage, text breathing-room, and readability defects explicitly.
You are given the exact measured pixel geometry of every element. Use it to make positional feedback concrete and numeric — never vague.
The measured geometry is AUTHORITATIVE: when a claim about a pixel gap, overlap, or alignment conflicts with the geometry numbers, trust the numbers, not your visual impression.
For equipment/inventory/item-tooltip surfaces, apply the checked-in RPG inventory UX lookbook rubric. Favor task readiness, decision delta, stable state/candidate/delta separation, visible constraints, expert throughput, and text safety over decorative polish.
Calibration — these exact claim patterns have been screenshot-vs-geometry false positives before; before making one of them, compute the actual delta from the geometry table and only report it if the number itself crosses the stated threshold:
- "slots touch" / "no breathing room" — only valid if the measured gap between the two boxes is <= 1px. A visible seam of several pixels is NOT touching.
- "tooltip overlaps the panel" — only valid if the tooltip box's edge coordinates actually exceed the panel box's edge coordinates. A tooltip fully inside the panel bounds is not an overlap, however close it looks.
- "icon is off-center in its slot" — only valid if the icon's centroid offset from its parent slot's centroid exceeds a few px both axes; a dx/dy of 0-1px is intentional centering, not a defect.
- "ring1/ring2 (or any named pair) are misaligned" — two elements are only "misaligned" if they share the same row or column in the geometry table; elements that are intentionally on different rows are not misaligned with each other.
- "a panel or paper doll is not optically centered" — only valid when the named content group's measured midpoint differs from its named container midpoint by more than 2px on the relevant axis. Never infer this from surrounding whitespace alone.
- "bag icons are off-center" — only valid when both the bag slot and its icon are declared in the geometry table and their measured centroids exceed the centering threshold above. Do not make this claim from a screenshot without icon geometry.
- "gear bonuses lack emphasis" — only valid when the supplied semantic evidence identifies a non-zero, player-visible equipment bonus that has no visual emphasis. Do not infer the absence of a bonus from a neutral value, and do not criticize a value highlight without evidence that its displayed effective value differs from its displayed base value.
If you cannot point to the specific geometry numbers that satisfy one of these thresholds, do not report the finding.`,
    user: `Review the attached screenshot of Crawler's "${opts.uxName}" UX surface.
Design intent for this surface: ${opts.uxGoal}.

MEASURED LAYOUT GEOMETRY (layout pixels, origin top-left; this is the SAME layout shown in the screenshot, so relative positions and pixel deltas are exact and directly actionable):
${geometryText}${rebuttalBlock}${regionIdsBlock}${ledgerSuppressBlock}

${inventoryLookbookBlock}

Score each axis 0-100 (0 = unacceptable, 100 = shippable quality):
- layout_consistency
- spacing_balance
- visual_hierarchy
- readability
- icon_usage
- typography_clarity
- thematic_fidelity

"overall.score" is a single 0-100 rating for the whole surface — never the sum or mean of the per-axis scores.

Use the FULL 0-100 range with real granularity. Do NOT round to multiples of 10, and do
not cluster every axis on the same number: a 62 and a 68 are meaningfully different
judgements and small fixes between rounds must be able to move the score. Calibration:
- 0-39 broken: a defect blocks the user from reading state or completing the task.
- 40-59 poor: usable but with obvious defects a player would notice immediately.
- 60-74 mediocre: no blocking defect, several visible polish problems remain.
- 75-84 good: solid, with minor refinements outstanding.
- 85-94 very good: shippable; only subjective or nice-to-have items remain.
- 95-100 exemplary: reserved for surfaces you cannot suggest a concrete improvement for.

Typography spacing standard is strict:
- Every text block must have visible top/bottom breathing room inside its container.
- Flag cramped text when cap-height/ascenders sit too close to borders, dividers, or neighboring rows.

Panel-composition standard (these are recurring, human-reported defects on this project —
check each one explicitly and report it in "precise_fixes" with a pixel delta):
- HEADING PLACEMENT CONSISTENCY: sibling section headings must share one convention. If one
  heading sits ABOVE its bounding box, every peer heading must too. A heading rendered inside
  its box while a sibling sits above it is a defect, even if each panel looks fine alone.
- PAIRED-SLOT ALIGNMENT: assess only pairs that are intended to share a measured row or
  column. The ten-slot paper doll deliberately places Ring 1 and Ring 2 on different
  anatomical rows; their different y-coordinates are correct and must not be reported.
  A pair whose two halves sit at different y is a defect.
- CONTAINER OVERRUN: no child element may touch or cross its container's top/bottom/side edge.
  Report the exact overlap in pixels.
- EXCESSIVE PADDING / OVER-WIDE LAYOUT: interior padding that dwarfs the content, or a surface
  stretched to full viewport width when its content does not need it, is a defect — not neutral.
  Say how many pixels to shrink and whether the content should be re-centred after.
- CENTERING: a focal cluster (paper doll, portrait, primary grid) must be optically centred in
  its pane both horizontally and vertically unless a deliberate alternative reads clearly.

${readabilityLines}

Thematic standard is strict: this is a **pixel dungeon crawler** UX.
If the UI reads as generic modern app chrome (flat/sterile panels, non-dungeon mood, weak pixel-art identity),
score thematic_fidelity <= 40 and include it as a blocking finding.

${hardRequirementLines}
${assetIntegrityBlock}

PRECISE, COORDINATE-LEVEL FIXES (REQUIRED wherever a defect is positional or sizing-related):
- For EVERY positional/spacing/sizing defect, emit an entry in "precise_fixes" as a concrete pixel delta on a NAMED element from the geometry table above.
- "element": the exact id from the geometry table (e.g. "tooltip", "panel", "slot:leftWrist", "slot:leftWrist.icon").
- "action": one of "move" (translate), "resize" (change width/height), "pad" (add interior padding).
- "dx"/"dy": signed pixels to translate — negative dx = move LEFT, negative dy = move UP. "dw"/"dh": signed pixels to grow(+)/shrink(-).
- "reason": one concrete sentence grounded in the measured numbers.
- Example: { "element": "tooltip", "action": "move", "dx": -18, "dy": 0, "reason": "tooltip left edge (x=384) overhangs into the leftWrist tile; shift left ~18px to sit flush beside it" }.
- Prefer precise_fixes over vague prose for anything measurable. Keep purely subjective/theming notes in recommended_fixes, not precise_fixes.
- If nothing positional is wrong, return "precise_fixes": [].

Return ONLY this JSON schema:
{
  "overall": { "score": number, "verdict": "fail" | "needs-work" | "pass", "summary": string },
  "axes": {
    "layout_consistency": { "score": number, "strengths": string[], "issues": string[] },
    "spacing_balance": { "score": number, "strengths": string[], "issues": string[] },
    "visual_hierarchy": { "score": number, "strengths": string[], "issues": string[] },
    "readability": { "score": number, "strengths": string[], "issues": string[] },
    "icon_usage": { "score": number, "strengths": string[], "issues": string[] },
    "typography_clarity": { "score": number, "strengths": string[], "issues": string[] },
    "thematic_fidelity": { "score": number, "strengths": string[], "issues": string[] }
  },
  "blocking_findings": string[],
  "recommended_fixes": string[],
  "precise_fixes": [
    { "element": string, "action": "move" | "resize" | "pad", "dx": number, "dy": number, "dw": number, "dh": number, "reason": string }
  ]${assetFindingsSchema}
}`,
  };
}

async function captureScreenshot(
  opts: Pick<
    CliOptions,
    'labUrl' | 'setupFile' | 'skipProbeWait' | 'waitMs' | 'clip' | 'viewport' | 'probeTimeoutMs'
  >,
  outPath: string,
  cropsDir: string | null,
): Promise<CaptureResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: opts.viewport });
  const page = await context.newPage();

  console.log(`[visual-review-agent] navigating to: ${opts.labUrl}`);
  await page.goto(opts.labUrl, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForFunction(
    (skipProbeWait) => {
      if (skipProbeWait) {
        return document.readyState === 'complete';
      }
      const globalWithProbe = window as unknown as {
        __uiProbe?: { ready?: () => boolean };
        __mainSceneProbe?: { ready?: () => boolean };
      };
      return (
        globalWithProbe.__uiProbe?.ready?.() === true ||
        globalWithProbe.__mainSceneProbe?.ready?.() === true
      );
    },
    opts.skipProbeWait,
    { timeout: opts.probeTimeoutMs },
  );
  await page.waitForTimeout(250);
  if (opts.setupFile) {
    const setupScript = readFileSync(opts.setupFile, 'utf-8');
    await page.evaluate(setupScript);
  } else {
    await page.evaluate(() => {
      const probe = (
        window as {
          __uiProbe?: { openEquipment: () => void; equipCharm?: () => boolean };
        }
      ).__uiProbe;
      probe?.openEquipment?.();
      probe?.equipCharm?.();
      const header = document.getElementById('app-header');
      if (header) header.style.display = 'none';
      const controls = document.getElementById('lab-controls');
      if (controls) controls.style.display = 'none';
      const host = document.getElementById('lab-canvas');
      if (host) {
        host.style.position = 'fixed';
        host.style.left = '0';
        host.style.top = '0';
        host.style.width = '100vw';
        host.style.height = '100vh';
        host.style.zIndex = '9999';
        host.style.background = '#000';
      }
      window.dispatchEvent(new Event('resize'));
    });
  }
  await page.waitForTimeout(opts.waitMs);
  const hoverPoint = await page.evaluate(() => {
    const globalWithHover = window as unknown as {
      __visualReviewHoverPoint?: { x?: unknown; y?: unknown };
    };
    const point = globalWithHover.__visualReviewHoverPoint;
    if (!point || typeof point !== 'object') return null;
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x, y };
  });
  if (hoverPoint) {
    await page.mouse.move(1, 1);
    await page.waitForTimeout(40);
    await page.mouse.move(hoverPoint.x, hoverPoint.y);
    await page.mouse.move(hoverPoint.x + 1, hoverPoint.y + 1);
    await page.waitForTimeout(120);
  }

  const harvest = await harvestSurface(page);
  if (harvest.source === 'equipment-legacy') {
    // A surface that predates the text-raster probe (e.g. an older commit being
    // baselined) has no font-load state to wait on. Treat a missing probe as
    // "nothing to wait for" rather than hanging until the timeout, so older
    // revisions remain reviewable for A/B comparison.
    await page.waitForFunction(
      () => {
        const probe = window.__uiProbe;
        if (typeof probe?.getEquipmentTextRasterMetadata !== 'function') {
          return document.readyState === 'complete';
        }
        const state = probe.getEquipmentTextRasterMetadata()?.fontLoadState;
        return state === 'loaded' || state === 'unavailable';
      },
      undefined,
      { timeout: 10_000 },
    );
  }
  let captured: CaptureResult;
  if (harvest.source === 'declared') {
    const regions = normalizeHarvestedRegions(harvest.regions);
    const computed = computeGeometryBlockers(regions);
    // Author-declared `flags` are treated as deterministic blockers alongside the
    // geometry the lib computes from the regions.
    const deterministicBlockers = [...new Set<string>([...computed, ...harvest.flags])];
    captured = {
      deterministicBlockers,
      geometry: emptyGeometry(),
      geometryText: formatRegions(harvest.surface, regions),
      harvestSource: 'declared',
      surface: harvest.surface,
      regions,
      expect: harvest.expect,
      evidenceRegions: [],
      textRaster: null,
    };
  } else if (harvest.source === 'equipment-legacy') {
    // Legacy EquipmentUI path: the two in-browser probes run VERBATIM so the
    // equipment review output stays byte-for-byte identical to before.
    const { deterministicBlockers, geometry } = await harvestEquipment(page);
    captured = {
      deterministicBlockers,
      geometry,
      geometryText: formatGeometry(geometry),
      harvestSource: 'equipment-legacy',
      surface: null,
      regions: [],
      expect: {
        tooltipAfterHover: true,
        statLabelsHumanReadable: true,
        sectionDividers: true,
      },
      evidenceRegions: [],
      textRaster: null,
    };
  } else {
    // No declared contract and no equipment probe: no deterministic checks, no
    // false blockers. main() prints a loud non-gating warning for this case.
    captured = {
      deterministicBlockers: [],
      geometry: emptyGeometry(),
      geometryText: NONE_GEOMETRY_NOTE,
      harvestSource: 'none',
      surface: null,
      regions: [],
      expect: {
        tooltipAfterHover: false,
        statLabelsHumanReadable: false,
        sectionDividers: false,
      },
      evidenceRegions: [],
      textRaster: null,
    };
  }
  const setupClip = normalizeClip(
    await page.evaluate(() => {
      const globalWithClip = window as unknown as { __visualReviewClip?: unknown };
      return globalWithClip.__visualReviewClip ?? null;
    }),
  );
  const screenshotClip = opts.clip ?? setupClip;
  await page.screenshot({
    path: outPath,
    fullPage: false,
    ...(screenshotClip ? { clip: screenshotClip } : {}),
  });
  if (captured.harvestSource === 'equipment-legacy') {
    captured.textRaster = await captureEquipmentTextRaster(page, outPath, screenshotClip);
    if (!captured.textRaster.passed) {
      captured.deterministicBlockers.push(
        ...captured.textRaster.failures.map((failure) => `text raster: ${failure}`),
      );
    }
  }

  // Art-review evidence corpus: crop each declared/published element in the
  // SAME screenshot space (browser still open) so we can later file the crops
  // as GOOD/BAD training examples once the LLM verdict is known.
  if (cropsDir) {
    captured.evidenceRegions = await captureEvidenceCrops(page, cropsDir);
  }

  await context.close();
  await browser.close();
  return captured;
}

/**
 * Analyze only the actual equipment text crops, never the whole screenshot. The
 * crop transform is obtained from the live canvas and the same screenshot clip
 * used for Azure, so the reported pixels are exactly the pixels under review.
 */
async function captureEquipmentTextRaster(
  page: Page,
  screenshotPath: string,
  clip: ScreenClip | null,
): Promise<TextRasterReport> {
  const harvested = await page.evaluate(() => {
    const probe = (
      window as unknown as {
        __uiProbe?: {
          getEquipmentTextRuns?: () => Array<{
            text?: unknown;
            region?: unknown;
            bounds?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
            fontFamily?: unknown;
            textResolution?: unknown;
            rasterScaleX?: unknown;
            rasterScaleY?: unknown;
          }>;
          getGameSize?: () => { width?: unknown; height?: unknown };
          getEquipmentTextRasterMetadata?: () => {
            intendedFontIdentity?: unknown;
            fontLoadState?: unknown;
            textResolution?: unknown;
            containerScale?: unknown;
          } | null;
        };
      }
    ).__uiProbe;
    const canvas = document.querySelector<HTMLCanvasElement>('#lab-canvas canvas');
    const game = probe?.getGameSize?.();
    const runs = probe?.getEquipmentTextRuns?.() ?? [];
    const raster = probe?.getEquipmentTextRasterMetadata?.();
    if (!canvas || !game || !(Number(game.width) > 0) || !(Number(game.height) > 0)) {
      return null;
    }
    const rect = canvas.getBoundingClientRect();
    const font = 'Press Start 2P';
    return {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      game: { width: Number(game.width), height: Number(game.height) },
      fontLoaded: raster?.fontLoadState === 'loaded',
      intendedFont:
        typeof raster?.intendedFontIdentity === 'string' ? raster.intendedFontIdentity : font,
      textResolution: Number(raster?.textResolution ?? 0),
      containerScale: Number(raster?.containerScale ?? 0),
      runs: runs
        .map((run, index) => {
          const bounds = run?.bounds;
          if (
            !bounds ||
            ![bounds.x, bounds.y, bounds.width, bounds.height].every((value) =>
              Number.isFinite(Number(value)),
            )
          ) {
            return null;
          }
          return {
            id: `${String(run.region ?? 'text')}:${index}`,
            text: typeof run.text === 'string' ? run.text : '',
            bounds: {
              x: Number(bounds.x),
              y: Number(bounds.y),
              width: Number(bounds.width),
              height: Number(bounds.height),
            },
            fontFamily:
              typeof run.fontFamily === 'string'
                ? run.fontFamily
                : String(raster?.intendedFontIdentity ?? font),
          };
        })
        .filter((run): run is NonNullable<typeof run> => run !== null),
    };
  });
  if (!harvested) {
    return evaluateTextRasterRuns([]);
  }

  const png = PNG.sync.read(readFileSync(screenshotPath));
  const scaleX = harvested.rect.width / harvested.game.width;
  const scaleY = harvested.rect.height / harvested.game.height;
  const offsetX = clip?.x ?? 0;
  const offsetY = clip?.y ?? 0;
  const runs = harvested.runs.map((run) => {
    const x = Math.floor(harvested.rect.x + run.bounds.x * scaleX - offsetX) - 1;
    const y = Math.floor(harvested.rect.y + run.bounds.y * scaleY - offsetY) - 1;
    const width = Math.ceil(run.bounds.width * scaleX) + 2;
    const height = Math.ceil(run.bounds.height * scaleY) + 2;
    const pixels = cropPng(png, x, y, width, height);
    const crop = measureCropCrispness(pixels);
    return {
      ...run,
      fontLoaded: harvested.fontLoaded,
      // Text-raster evidence describes the final captured pixels, including
      // the browser canvas transform that can resample the scene.
      ...toScreenshotRasterGeometry({
        bounds: run.bounds,
        rect: harvested.rect,
        scaleX,
        scaleY,
        offsetX,
        offsetY,
        containerScale: harvested.containerScale,
      }),
      resolution: harvested.textResolution,
      crispness: crop.score,
      sampledEdges: crop.sampledEdges,
    };
  });
  return evaluateTextRasterRuns(runs);
}

function cropPng(png: PNG, x: number, y: number, width: number, height: number) {
  const left = Math.max(0, x);
  const top = Math.max(0, y);
  const right = Math.min(png.width, x + width);
  const bottom = Math.min(png.height, y + height);
  const cropWidth = Math.max(0, right - left);
  const cropHeight = Math.max(0, bottom - top);
  const data = new Uint8Array(cropWidth * cropHeight * 4);
  for (let row = 0; row < cropHeight; row += 1) {
    const source = ((top + row) * png.width + left) * 4;
    const target = row * cropWidth * 4;
    data.set(png.data.subarray(source, source + cropWidth * 4), target);
  }
  return { pixels: data, width: cropWidth, height: cropHeight };
}

/**
 * Crop every element published on `window.__evidenceRegions` (world-pixel rects)
 * into screenshot-space PNGs. World -> screenshot transform uses the live camera
 * worldView + zoom and the canvas client rect, so crops line up with the capture
 * regardless of camera fit/zoom. Off-screen / sub-4px regions are skipped.
 */
async function captureEvidenceCrops(page: Page, cropsDir: string): Promise<EvidenceRegionShot[]> {
  let boxes: Array<{ id: string; kind: string; box: EvidenceRegionShot['box'] }> | null;
  try {
    boxes = await page.evaluate(() => {
      const w = window as unknown as {
        __setPieceScene?: {
          cameras?: { main?: { worldView?: { x: number; y: number }; zoom?: number } };
          scale?: { width?: number; height?: number };
          game?: { canvas?: HTMLCanvasElement };
        };
        __evidenceRegions?: Array<{
          id?: unknown;
          kind?: unknown;
          centreXpx?: unknown;
          centreYpx?: unknown;
          halfWpx?: unknown;
          halfHpx?: unknown;
        }>;
      };
      const scene = w.__setPieceScene;
      const regions = w.__evidenceRegions;
      const cam = scene?.cameras?.main;
      const canvas = scene?.game?.canvas;
      if (!scene || !Array.isArray(regions) || !cam || !canvas || !cam.worldView) return null;
      const wv = cam.worldView;
      const zoom = typeof cam.zoom === 'number' && cam.zoom > 0 ? cam.zoom : 1;
      const rect = canvas.getBoundingClientRect();
      const gw = scene.scale?.width ?? rect.width;
      const gh = scene.scale?.height ?? rect.height;
      const sx = gw > 0 ? rect.width / gw : 1;
      const sy = gh > 0 ? rect.height / gh : 1;
      const out: Array<{
        id: string;
        kind: string;
        box: { x: number; y: number; width: number; height: number };
      }> = [];
      for (const r of regions) {
        const cx = Number(r.centreXpx);
        const cy = Number(r.centreYpx);
        const hw = Number(r.halfWpx);
        const hh = Number(r.halfHpx);
        if (![cx, cy, hw, hh].every((v) => Number.isFinite(v))) continue;
        const gx = (cx - wv.x) * zoom;
        const gy = (cy - wv.y) * zoom;
        const wpx = hw * 2 * zoom * sx;
        const hpx = hh * 2 * zoom * sy;
        const px = rect.left + (gx - hw * zoom) * sx;
        const py = rect.top + (gy - hh * zoom) * sy;
        out.push({
          id: typeof r.id === 'string' && r.id.length > 0 ? r.id : 'element',
          kind: typeof r.kind === 'string' ? r.kind : 'prop',
          box: { x: px, y: py, width: wpx, height: hpx },
        });
      }
      return out;
    });
  } catch {
    return [];
  }
  if (!boxes || boxes.length === 0) return [];
  mkdirSync(cropsDir, { recursive: true });
  const viewport = page.viewportSize() ?? { width: 1600, height: 1000 };
  const shots: EvidenceRegionShot[] = [];
  const usedNames = new Set<string>();
  for (const b of boxes) {
    const x = Math.max(0, Math.floor(b.box.x));
    const y = Math.max(0, Math.floor(b.box.y));
    const right = Math.min(viewport.width, Math.ceil(b.box.x + b.box.width));
    const bottom = Math.min(viewport.height, Math.ceil(b.box.y + b.box.height));
    const width = right - x;
    const height = bottom - y;
    let cropPath: string | null = null;
    if (width >= 4 && height >= 4) {
      let token = safeFileToken(b.id);
      while (usedNames.has(token)) token = `${token}_`;
      usedNames.add(token);
      cropPath = resolve(cropsDir, `${token}.png`);
      try {
        await page.screenshot({ path: cropPath, clip: { x, y, width, height } });
      } catch {
        cropPath = null;
      }
    }
    shots.push({ id: b.id, kind: b.kind, box: { x, y, width, height }, cropPath });
  }
  return shots;
}

/** Sanitize an element id for use as a filesystem token. */
function safeFileToken(id: string): string {
  const token = id
    .toLowerCase()
    .replace(/&[a-z]+;/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return token.length > 0 ? token : 'element';
}

function formatGeometry(geo: GeometrySnapshot): string {
  const fmt = (b: ElementBox | null): string =>
    b
      ? `x=${b.x} y=${b.y} w=${b.width} h=${b.height} (right=${b.x + b.width} bottom=${b.y + b.height})`
      : 'not-present';
  const lines: string[] = [];
  lines.push(`panel              ${fmt(geo.panel)}`);
  lines.push(`tooltip            ${fmt(geo.tooltip)}`);
  for (const s of geo.slots) {
    if (!s.box) continue;
    lines.push(`slot:${s.id.padEnd(12)} ${fmt(s.box)}`);
    if (s.icon) lines.push(`slot:${`${s.id}.icon`.padEnd(12)} ${fmt(s.icon)}`);
  }
  return lines.join('\n');
}

function emptyGeometry(): GeometrySnapshot {
  return { panel: null, tooltip: null, slots: [] };
}

const NONE_GEOMETRY_NOTE =
  '(no measured geometry: this surface did not declare window.__visualReview and is not the legacy equipment probe. ' +
  'Findings below are from the screenshot ONLY and are NOT pixel-verified — declare window.__visualReview in the ' +
  'setup file to enable deterministic, pixel-grounded checks.)';

/** Render the declared-region table for the prompt (rounds coords for display only). */
function formatRegions(surface: string | null, regions: VisualReviewRegion[]): string {
  if (regions.length === 0) return '(no regions declared)';
  const fmt = (b: VisualReviewBox): string => {
    const x = Math.round(b.x);
    const y = Math.round(b.y);
    const w = Math.round(b.width);
    const h = Math.round(b.height);
    return `x=${x} y=${y} w=${w} h=${h} (right=${x + w} bottom=${y + h})`;
  };
  const lines: string[] = [];
  if (surface) lines.push(`surface: ${surface}`);
  for (const r of regions) {
    const kind = `[${r.kind ?? 'other'}]`;
    const parent = r.parentId ? ` parent=${r.parentId}` : '';
    lines.push(`${r.id.padEnd(20)} ${fmt(r.box)} ${kind}${parent}`);
  }
  return lines.join('\n');
}

const ALLOWED_REGION_KINDS = new Set(['slot', 'icon', 'panel', 'tooltip', 'text', 'other']);

/** Coerce the raw harvested regions into valid `VisualReviewRegion`s (drops invalid boxes). */
function normalizeHarvestedRegions(raw: unknown): VisualReviewRegion[] {
  if (!Array.isArray(raw)) return [];
  const out: VisualReviewRegion[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as { id?: unknown; box?: unknown; kind?: unknown; parentId?: unknown };
    const id = typeof r.id === 'string' ? r.id.trim() : '';
    if (!id) continue;
    if (!r.box || typeof r.box !== 'object') continue;
    const b = r.box as { x?: unknown; y?: unknown; width?: unknown; height?: unknown };
    const x = Number(b.x);
    const y = Number(b.y);
    const width = Number(b.width);
    const height = Number(b.height);
    if (![x, y, width, height].every((n) => Number.isFinite(n))) continue;
    if (width <= 0 || height <= 0) continue;
    const kind =
      typeof r.kind === 'string' && ALLOWED_REGION_KINDS.has(r.kind)
        ? (r.kind as VisualReviewRegion['kind'])
        : 'other';
    const parentId =
      typeof r.parentId === 'string' && r.parentId.trim().length > 0
        ? r.parentId.trim()
        : undefined;
    out.push({ id, box: { x, y, width, height }, kind, parentId });
  }
  return out;
}

type HarvestData =
  | {
      source: 'declared';
      surface: string | null;
      regions: unknown;
      flags: string[];
      expect: SurfaceExpectations;
    }
  | { source: 'equipment-legacy' }
  | { source: 'none' };

/**
 * Decide which harvest path applies and, for a declared surface, return ONLY the
 * raw harvested data (regions/flags/expect/surface). All geometry math happens in
 * Node so the browser side stays a dumb data source.
 */
async function harvestSurface(page: Page): Promise<HarvestData> {
  const declared = (await page.evaluate(() => {
    const g = window as unknown as {
      __visualReview?: {
        surface?: unknown;
        regions?: unknown;
        flags?: unknown;
        expect?: {
          tooltipAfterHover?: unknown;
          statLabelsHumanReadable?: unknown;
          sectionDividers?: unknown;
        };
      };
    };
    const decl = g.__visualReview;
    if (!decl || typeof decl !== 'object') return null;
    const regionsIn = Array.isArray(decl.regions) ? decl.regions : [];
    const regions = regionsIn.map((entry) => {
      const rr = (entry ?? {}) as {
        id?: unknown;
        box?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
        kind?: unknown;
        parentId?: unknown;
      };
      const b = rr.box ?? {};
      return {
        id: rr.id,
        box: { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) },
        kind: rr.kind,
        parentId: rr.parentId,
      };
    });
    const flags = Array.isArray(decl.flags)
      ? decl.flags.filter((f): f is string => typeof f === 'string')
      : [];
    const e = decl.expect && typeof decl.expect === 'object' ? decl.expect : {};
    return {
      surface: typeof decl.surface === 'string' ? decl.surface : null,
      regions,
      flags,
      expect: {
        tooltipAfterHover: e.tooltipAfterHover === true,
        statLabelsHumanReadable: e.statLabelsHumanReadable === true,
        sectionDividers: e.sectionDividers === true,
      },
    };
  })) as {
    surface: string | null;
    regions: unknown;
    flags: string[];
    expect: SurfaceExpectations;
  } | null;
  if (declared) {
    return {
      source: 'declared',
      surface: declared.surface,
      regions: declared.regions,
      flags: declared.flags,
      expect: declared.expect,
    };
  }

  const isEquipment = await page.evaluate(() => {
    const probe = (window as unknown as { __uiProbe?: Record<string, unknown> }).__uiProbe;
    return !!probe && typeof probe.getEquipmentSlotBounds === 'function';
  });
  return isEquipment ? { source: 'equipment-legacy' } : { source: 'none' };
}

/**
 * Legacy EquipmentUI harvest. These two `page.evaluate` blocks are the ORIGINAL
 * equipment probes moved here VERBATIM (byte-for-byte) — do not modify them; the
 * equipment review output must stay identical.
 */
async function harvestEquipment(
  page: Page,
): Promise<{ deterministicBlockers: string[]; geometry: GeometrySnapshot }> {
  const deterministicBlockers = (await page.evaluate(`
    (() => {
      const slotIds = [
        'head','face','neck','shoulders','chest','back','leftArm','rightArm',
        'leftWrist','rightWrist','mainHand','offHand','gloves','ringLeft','ringRight',
        'belt','legs','feet'
      ];
      const probe = window.__uiProbe;
      const blockers = [];
      if (!probe || typeof probe.getEquipmentSlotBounds !== 'function') {
        return ['Deterministic geometry check failed: window.__uiProbe.getEquipmentSlotBounds unavailable.'];
      }

      const slots = [];
      for (const slotId of slotIds) {
        const raw = probe.getEquipmentSlotBounds(slotId);
        if (!raw || typeof raw !== 'object') continue;
        const x = Number(raw.x);
        const y = Number(raw.y);
        const width = Number(raw.width);
        const height = Number(raw.height);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) continue;
        if (width <= 0 || height <= 0) continue;
        slots.push({ slotId, box: { x, y, width, height } });
      }

      for (let i = 0; i < slots.length; i += 1) {
        for (let j = i + 1; j < slots.length; j += 1) {
          const a = slots[i];
          const b = slots[j];
          const x1 = Math.max(a.box.x, b.box.x);
          const y1 = Math.max(a.box.y, b.box.y);
          const x2 = Math.min(a.box.x + a.box.width, b.box.x + b.box.width);
          const y2 = Math.min(a.box.y + a.box.height, b.box.y + b.box.height);
          const overlapW = Math.max(0, x2 - x1);
          const overlapH = Math.max(0, y2 - y1);
          const overlap = overlapW * overlapH;
          if (overlap > 0) blockers.push('Slot boxes overlap: ' + a.slotId + ' intersects ' + b.slotId + '.');

          if (overlap === 0) {
            const horizontalGap = Math.max(
              a.box.x - (b.box.x + b.box.width),
              b.box.x - (a.box.x + a.box.width),
              0
            );
            const verticalGap = Math.max(
              a.box.y - (b.box.y + b.box.height),
              b.box.y - (a.box.y + a.box.height),
              0
            );
            const touchesVertically = verticalGap <= 1 && overlapW >= 8;
            const touchesHorizontally = horizontalGap <= 1 && overlapH >= 8;
            if (touchesVertically || touchesHorizontally) {
              blockers.push('Slot boxes touch with no breathing room: ' + a.slotId + ' adjacent to ' + b.slotId + '.');
            }
          }
        }
      }

      if (typeof probe.getEquipmentSlotIconBounds === 'function') {
        for (const slot of slots) {
          const raw = probe.getEquipmentSlotIconBounds(slot.slotId);
          if (!raw || typeof raw !== 'object') continue;
          const ix = Number(raw.x);
          const iy = Number(raw.y);
          const iw = Number(raw.width);
          const ih = Number(raw.height);
          if (!Number.isFinite(ix) || !Number.isFinite(iy) || !Number.isFinite(iw) || !Number.isFinite(ih)) continue;
          if (iw <= 0 || ih <= 0) continue;
          const t = 1;
          const inside =
            ix >= slot.box.x - t &&
            iy >= slot.box.y - t &&
            ix + iw <= slot.box.x + slot.box.width + t &&
            iy + ih <= slot.box.y + slot.box.height + t;
          if (!inside) blockers.push('Slot icon escapes its box: ' + slot.slotId + '.');
        }
      }

      const tooltipVisible =
        typeof probe.isEquipmentTooltipVisible === 'function' && probe.isEquipmentTooltipVisible() === true;
      if (!tooltipVisible) {
        blockers.push('Empty-slot tooltip is not visible after hover interaction.');
      } else {
        if (typeof probe.isEquipmentTooltipTopmost === 'function' && probe.isEquipmentTooltipTopmost() !== true) {
          blockers.push('Equipment tooltip is rendered behind other panel elements.');
        }
        if (
          typeof probe.getEquipmentTooltipBounds === 'function' &&
          typeof probe.getEquipmentPanelBounds === 'function'
        ) {
          const tb = probe.getEquipmentTooltipBounds();
          const pb = probe.getEquipmentPanelBounds();
          if (tb && pb) {
            const withinPanel =
              tb.x >= pb.x - 1 &&
              tb.y >= pb.y - 1 &&
              tb.x + tb.width <= pb.x + pb.width + 1 &&
              tb.y + tb.height <= pb.y + pb.height + 1;
            if (!withinPanel) blockers.push('Equipment tooltip is clipped/outside panel bounds.');
          }
        }
      }
      return blockers;
    })();
  `)) as string[];
  const geometry = (await page.evaluate(`
    (() => {
      const probe = window.__uiProbe;
      const ids = [
        'head','neck','mainHand','chest','offHand',
        'gloves','legs','ring1','feet','ring2'
      ];
      const norm = (b) => (b && typeof b === 'object' && Number.isFinite(b.x))
        ? { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }
        : null;
      const call = (fn, id) => {
        if (!probe || typeof probe[fn] !== 'function') return null;
        try { return norm(id === undefined ? probe[fn]() : probe[fn](id)); } catch (e) { return null; }
      };
      return {
        panel: call('getEquipmentPanelBounds'),
        tooltip: call('getEquipmentTooltipBounds'),
        slots: ids.map((id) => ({
          id,
          box: call('getEquipmentSlotBounds', id),
          icon: call('getEquipmentSlotIconBounds', id),
        })),
      };
    })();
  `)) as GeometrySnapshot;
  // Run the shared declared-surface geometry checks over the legacy equipment
  // snapshot too, so containment and paired-slot alignment are measured rather
  // than left to the LLM (which reported them inconsistently). The in-page
  // checks above stay byte-for-byte intact; these are additive and deduped.
  const regions: VisualReviewRegion[] = [];
  if (geometry.panel) regions.push({ id: 'panel', box: geometry.panel, kind: 'panel' });
  for (const slot of geometry.slots ?? []) {
    if (slot.box) {
      regions.push({
        id: `slot:${slot.id}`,
        box: slot.box,
        kind: 'slot',
        ...(geometry.panel ? { parentId: 'panel' } : {}),
      });
    }
    if (slot.icon && slot.box) {
      regions.push({
        id: `slot:${slot.id}.icon`,
        box: slot.icon,
        kind: 'icon',
        parentId: `slot:${slot.id}`,
      });
    }
  }
  for (const blocker of computeGeometryBlockers(regions)) {
    if (!deterministicBlockers.includes(blocker)) deterministicBlockers.push(blocker);
  }
  return { deterministicBlockers, geometry };
}

function printResult(result: VisualReviewResult, screenshotPath: string, reviewPath: string): void {
  const score = result.overall?.score ?? 0;
  const rawScore = result.overall?.raw_score;
  const derivation = result.score_derivation;
  const normalizedNote =
    rawScore !== undefined && rawScore !== score
      ? ` (anchored; model self-reported ${JSON.stringify(rawScore)})`
      : '';
  const verdict = result.overall?.verdict ?? 'fail';
  const summary = result.overall?.summary ?? 'no summary returned';
  const blockers = result.blocking_findings ?? [];
  const deterministic = new Set(result.deterministic_blocking_findings ?? []);
  const trajectory = result.finding_trajectory;

  console.log(
    `\n[visual-review-agent] harvest=${result.harvest_source ?? 'unknown'}` +
      `${result.surface ? ` surface=${result.surface}` : ''}`,
  );
  console.log(
    `[visual-review-agent] verdict=${verdict} score=${score.toFixed(1)}/100${normalizedNote}`,
  );
  console.log(`[visual-review-agent] summary: ${summary}`);
  if (derivation) {
    console.log(
      `[visual-review-agent] score = axisMean ${derivation.axis_mean} - penalty ${derivation.penalty}` +
        ` (${derivation.deterministic_blockers} deterministic x${DETERMINISTIC_BLOCKER_PENALTY}` +
        ` + ${derivation.llm_blockers} llm x${LLM_BLOCKER_PENALTY})`,
    );
    console.log(
      "[visual-review-agent] NOTE: the model's own headline score is anchored noise " +
        '(byte-identical captures scored 72/72/72 with 2/0/3 blockers) and is NOT used.',
    );
  }
  if (result.capture_unchanged_from_prior) {
    console.log(
      '[visual-review-agent] CAPTURE UNCHANGED: byte-identical to the prior capture. Do not ' +
        'report any score/finding movement from this run as an improvement.',
    );
  }
  if (blockers.length > 0) {
    console.log('[visual-review-agent] blocking findings:');
    for (const finding of blockers) {
      const tag = deterministic.has(finding) ? '[deterministic]' : '[llm]';
      console.log(`  - ${tag} ${finding}`);
    }
  }
  if (trajectory) {
    console.log(
      `[visual-review-agent] finding trajectory vs prior run: ${trajectory.new.length} NEW, ${trajectory.recurring.length} RECURRING`,
    );
    for (const finding of trajectory.new) {
      console.log(`  - [NEW] ${finding}`);
    }
    for (const finding of trajectory.recurring) {
      console.log(`  - [RECURRING] ${finding}`);
    }
  }
  const preciseFixes = result.precise_fixes ?? [];
  if (preciseFixes.length > 0) {
    console.log('[visual-review-agent] precise fixes (pixel deltas):');
    for (const f of preciseFixes) {
      const deltas = [
        f.dx !== undefined && f.dx !== 0 ? `dx=${f.dx}` : '',
        f.dy !== undefined && f.dy !== 0 ? `dy=${f.dy}` : '',
        f.dw !== undefined && f.dw !== 0 ? `dw=${f.dw}` : '',
        f.dh !== undefined && f.dh !== 0 ? `dh=${f.dh}` : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(`  - [${f.action}] ${f.element} ${deltas} :: ${f.reason ?? ''}`);
    }
  }
  const recommended = result.recommended_fixes ?? [];
  if (recommended.length > 0) {
    console.log('[visual-review-agent] recommended fixes:');
    for (const fix of recommended) {
      console.log(`  - ${fix}`);
    }
  }
  console.log(`[visual-review-agent] screenshot: ${screenshotPath}`);
  console.log(`[visual-review-agent] report: ${reviewPath}`);
}

/**
 * Load blocking-finding keys from the most recent prior review artifact for this
 * surface (same screenshot-name prefix), so we can label current findings NEW vs
 * RECURRING. Timestamp suffixes sort lexicographically in chronological order.
 */
function loadPriorFindingKeys(
  outputDir: string,
  screenshotName: string,
  currentReviewFile: string,
): string[] | null {
  let entries: string[];
  try {
    entries = readdirSync(outputDir);
  } catch {
    return null;
  }
  const prefix = `${screenshotName}-`;
  const candidates = entries
    .filter(
      (name) =>
        name.startsWith(prefix) && name.endsWith('.review.json') && name !== currentReviewFile,
    )
    .sort();
  const latest = candidates.at(-1);
  if (!latest) return null;
  try {
    const raw = JSON.parse(readFileSync(resolve(outputDir, latest), 'utf-8')) as VisualReviewResult;
    return findingKeys(raw.blocking_findings ?? []);
  } catch {
    return null;
  }
}

/**
 * Hash of the most recent prior capture for this surface, so an "iteration" that
 * changed no pixels can be flagged instead of being re-judged and mistaken for
 * progress. This is not hypothetical: in one 12-round iteration loop, six
 * captures were byte-identical to their predecessor (iter01≡02, 03≡04, 09≡10,
 * 11≡12) yet the judge returned different scores and blocker counts for them,
 * and that noise was read as a real regression-then-fix.
 */
function loadPriorCaptureHash(
  outputDir: string,
  screenshotName: string,
  currentScreenshotFile: string,
): { file: string; hash: string } | null {
  let entries: string[];
  try {
    entries = readdirSync(outputDir);
  } catch {
    return null;
  }
  const prefix = `${screenshotName}-`;
  const latest = entries
    .filter(
      (name) => name.startsWith(prefix) && name.endsWith('.png') && name !== currentScreenshotFile,
    )
    .sort()
    .at(-1);
  if (!latest) return null;
  try {
    const buf = readFileSync(resolve(outputDir, latest));
    return { file: latest, hash: createHash('sha256').update(buf).digest('hex') };
  } catch {
    return null;
  }
}

/**
 * Load the art-regen ledger. A MISSING file is the normal first-run case (nothing
 * queued yet) → an empty ledger. A present-but-corrupt file FAILS CLOSED via
 * {@link parseArtLedger} (throws), because silently degrading to an empty
 * suppress-list would re-critique every already-queued asset — the exact behavior
 * the ledger exists to prevent.
 */
function loadArtLedger(path: string): ArtLedger {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return { updated: '', note: DEFAULT_LEDGER_NOTE, assets: [] };
    }
    // Permission / other IO error: fail loudly rather than silently un-suppress.
    throw err;
  }
  return parseArtLedger(raw);
}

function saveArtLedger(path: string, ledger: ArtLedger): void {
  mkdirSync(resolve(path, '..'), { recursive: true });
  ledger.updated = new Date().toISOString();
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf-8');
}

const EVIDENCE_STOPWORDS = new Set([
  'welcome',
  'room',
  'npc',
  'prop',
  'the',
  'and',
  'for',
  'its',
  'has',
  'var',
  'layer',
  'side',
  'set',
  'piece',
  'with',
  'wall',
  'floor',
  'left',
  'right',
  'back',
  'front',
  'top',
  'this',
  'that',
  'too',
  'not',
  'are',
  'was',
  'sitting',
  'looks',
  'look',
  'from',
  'onto',
  'into',
]);

/** Distinctive lowercase word tokens of a label/finding for fuzzy element matching. */
function distinctiveTokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2 && !EVIDENCE_STOPWORDS.has(t)),
  );
}

function tokensIntersect(a: Set<string>, pool: Set<string>): boolean {
  for (const t of a) if (pool.has(t)) return true;
  return false;
}

/** Flatten all axis strengths into a single GOOD-observation list. */
function collectGoodNotes(result: VisualReviewResult): string[] {
  const out: string[] = [];
  for (const axis of Object.values(result.axes ?? {})) {
    for (const s of axis.strengths ?? []) out.push(s);
  }
  return out;
}

/** Flatten blocking findings + asset-finding issues into a single BAD list. */
function collectBadNotes(result: VisualReviewResult): string[] {
  const out: string[] = [...(result.blocking_findings ?? [])];
  for (const f of result.asset_findings ?? []) {
    out.push(`${f.asset}${f.prop ? ` (${f.prop})` : ''}: ${f.issue ?? f.kind ?? 'asset defect'}`);
  }
  return out;
}

/**
 * File each captured crop into crops/good|bad|neutral by fuzzy-matching the
 * element id against the run's GOOD/BAD note pools (BAD wins ties). Returns a
 * manifest describing each labeled crop for evidence.json.
 */
function labelAndFileCrops(
  bundleDir: string,
  regions: EvidenceRegionShot[],
  result: VisualReviewResult,
): Array<{
  id: string;
  kind: string;
  label: 'good' | 'bad' | 'neutral';
  box: EvidenceRegionShot['box'];
  crop: string | null;
}> {
  const badTokens = new Set<string>();
  for (const n of collectBadNotes(result)) for (const t of distinctiveTokens(n)) badTokens.add(t);
  const goodTokens = new Set<string>();
  for (const n of collectGoodNotes(result)) for (const t of distinctiveTokens(n)) goodTokens.add(t);
  const manifest: Array<{
    id: string;
    kind: string;
    label: 'good' | 'bad' | 'neutral';
    box: EvidenceRegionShot['box'];
    crop: string | null;
  }> = [];
  for (const r of regions) {
    const idTokens = distinctiveTokens(r.id);
    const label: 'good' | 'bad' | 'neutral' = tokensIntersect(idTokens, badTokens)
      ? 'bad'
      : tokensIntersect(idTokens, goodTokens)
        ? 'good'
        : 'neutral';
    let rel: string | null = null;
    if (r.cropPath) {
      const destDir = resolve(bundleDir, 'crops', label);
      mkdirSync(destDir, { recursive: true });
      const fileName = `${safeFileToken(r.id)}.png`;
      const dest = resolve(destDir, fileName);
      try {
        renameSync(r.cropPath, dest);
        rel = `crops/${label}/${fileName}`;
      } catch {
        rel = null;
      }
    }
    manifest.push({ id: r.id, kind: r.kind, label, box: r.box, crop: rel });
  }
  return manifest;
}

/**
 * Write a labeled GOOD/BAD evidence bundle for this review round: the full
 * screenshot, per-element crops filed under crops/good|bad|neutral, and an
 * evidence.json capturing the verdict + good/bad observations + ledger deltas.
 * This corpus is a durable training/QA record for improving the judge later.
 */
function writeEvidenceBundle(args: {
  bundleDir: string;
  stamp: string;
  isoNow: string;
  uxName: string;
  uxGoal: string;
  screenshotPath: string;
  score: number;
  result: VisualReviewResult;
  regions: EvidenceRegionShot[];
}): string {
  const { bundleDir, screenshotPath, result, regions } = args;
  mkdirSync(bundleDir, { recursive: true });
  try {
    copyFileSync(screenshotPath, resolve(bundleDir, 'full.png'));
  } catch {
    /* full-frame copy is best-effort */
  }
  const labeled = labelAndFileCrops(bundleDir, regions, result);
  const evidence = {
    stamp: args.stamp,
    captured_at: args.isoNow,
    ux_name: args.uxName,
    ux_goal: args.uxGoal,
    score: args.score,
    verdict: result.overall?.verdict ?? 'unknown',
    summary: result.overall?.summary ?? '',
    good: collectGoodNotes(result),
    bad: collectBadNotes(result),
    blocking_findings: result.blocking_findings ?? [],
    asset_findings: result.asset_findings ?? [],
    ledger_added: result.ledger_added ?? [],
    suppressed_ledger_assets: result.suppressed_ledger_assets ?? [],
    counts: {
      elements: labeled.length,
      bad: labeled.filter((l) => l.label === 'bad').length,
      good: labeled.filter((l) => l.label === 'good').length,
      neutral: labeled.filter((l) => l.label === 'neutral').length,
    },
    elements: labeled,
    full: 'full.png',
  };
  writeFileSync(
    resolve(bundleDir, 'evidence.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf-8',
  );
  return bundleDir;
}

async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('[visual-review-agent] Refusing to run in CI (dev-session tool only).');
    return 2;
  }

  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.outputDir, { recursive: true });
  const stamp = nowStamp();
  const isoNow = new Date().toISOString();
  const screenshotPath = resolve(opts.outputDir, `${opts.screenshotName}-${stamp}.png`);
  const reviewPath = resolve(opts.outputDir, `${opts.screenshotName}-${stamp}.review.json`);

  // Art-review mode: resolve the ledger + evidence-corpus paths, and the raw
  // crops dir passed into capture (so per-element crops are grabbed while the
  // browser is still open).
  const artLedgerPath = opts.artReview
    ? (opts.artLedger ?? resolve(opts.outputDir, 'art-regen-ledger.json'))
    : null;
  const evidenceRoot = opts.artReview
    ? (opts.evidenceDir ?? resolve(opts.outputDir, 'evidence'))
    : null;
  const evidenceBundleDir = evidenceRoot
    ? resolve(evidenceRoot, `${opts.screenshotName}-${stamp}`)
    : null;
  const rawCropsDir = evidenceBundleDir ? resolve(evidenceBundleDir, 'crops', '_raw') : null;
  const ledger = artLedgerPath ? loadArtLedger(artLedgerPath) : null;

  const capture = await captureScreenshot(opts, screenshotPath, rawCropsDir);
  if (lacksPixelGroundedGeometry(capture.harvestSource, capture.regions.length)) {
    // Either no contract at all ('none') or a declared-but-empty (misconfigured)
    // surface. Both silently degrade to screenshot-only, non-pixel-grounded
    // feedback — the exact failure mode this tool exists to prevent — so warn
    // loudly (but do NOT gate: the LLM pass still runs).
    console.warn(
      capture.harvestSource === 'declared'
        ? '[visual-review-agent] WARNING: window.__visualReview was declared but produced 0 valid regions ' +
            '(misconfigured setup — every region was dropped for a missing id or a non-finite / zero-area box). ' +
            'No deterministic geometry checks ran; findings are screenshot-only and NOT pixel-grounded. Fix the ' +
            'region boxes so each has a non-empty id and a positive-area box in the screenshot coordinate space.'
        : '[visual-review-agent] WARNING: this surface declared no window.__visualReview and is not the legacy ' +
            'equipment probe. No deterministic geometry checks ran; findings are screenshot-only and NOT pixel-grounded. ' +
            'Declare window.__visualReview in your setup file to get deterministic, pixel-grounded checks.',
    );
  } else if (capture.harvestSource === 'equipment-legacy') {
    const geo = capture.geometry;
    console.log(
      `[visual-review-agent] geometry captured (equipment-legacy): panel=${geo.panel ? 'yes' : 'NULL'} ` +
        `tooltip=${geo.tooltip ? 'yes' : 'NULL'} ` +
        `slots=${geo.slots.filter((s) => s.box).length}/${geo.slots.length} with-box`,
    );
  } else {
    console.log(
      `[visual-review-agent] geometry harvested (declared): surface=${capture.surface ?? '(unnamed)'} ` +
        `regions=${capture.regions.length} deterministic-blockers=${capture.deterministicBlockers.length}`,
    );
  }

  const endpoint = readEnvVar('AZURE_OPENAI_ENDPOINT');
  const apiKey = readEnvVar('AZURE_OPENAI_API_KEY');
  const deployment = (
    process.env.AZURE_OPENAI_VISION_DEPLOYMENT ||
    process.env.AZURE_OPENAI_DEPLOYMENT ||
    ''
  ).trim();
  if (!deployment) {
    throw new Error(
      'missing required env var AZURE_OPENAI_VISION_DEPLOYMENT (or AZURE_OPENAI_DEPLOYMENT)',
    );
  }
  const apiVersion = (process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview').trim();

  const provider = new AzureOpenAIVisionProvider({
    endpoint,
    apiKey,
    deployment,
    apiVersion,
  });
  const textRasterText = capture.textRaster
    ? `\n\nTEXT RASTER EVIDENCE (AUTHORITATIVE FOR BLUR/FUZZINESS): ${
        capture.textRaster.passed
          ? `PASS — ${capture.textRaster.entries.length} declared text crops have a loaded intended font, integer-aligned raster geometry, and calibrated sharp edges. Do not report text as fuzzy, blurry, soft, or in need of a sharper font unless a visible contradiction is specific and high confidence.`
          : `FAIL — ${capture.textRaster.failures.join('; ')}. You may discuss only these named deterministic text-raster failures.`
      }`
    : '';
  const prompt = buildPrompt(opts, `${capture.geometryText}${textRasterText}`, {
    expect: capture.expect,
    regionIds: capture.regions.map((r) => r.id),
    artReview: opts.artReview,
    ledgerAssets: ledger?.assets.filter((a) => a.status === 'needs-regen') ?? [],
  });
  const png = readFileSync(screenshotPath);
  const priorCapture = loadPriorCaptureHash(
    opts.outputDir,
    opts.screenshotName,
    basename(screenshotPath),
  );
  const captureHash = createHash('sha256').update(png).digest('hex');
  const captureUnchanged = priorCapture !== null && priorCapture.hash === captureHash;
  if (captureUnchanged) {
    console.warn(
      `[visual-review-agent] WARNING: this capture is BYTE-IDENTICAL to the prior capture ` +
        `(${priorCapture.file}). Nothing you changed affected these pixels, so any score or ` +
        `finding difference from the previous run is model noise, not progress.`,
    );
  }
  const evaluation = await provider.evaluate({
    systemInstructions: prompt.system,
    userPrompt: prompt.user,
    images: [{ label: opts.uxName, png }],
    temperature: 0,
    maxTokens: 1800,
  });

  const result = extractJsonObject(evaluation.json);
  if (capture.textRaster) {
    result.text_raster = capture.textRaster;
    result.suppressed_text_raster_findings = suppressUnsupportedFuzziness(
      result,
      capture.textRaster,
    );
  }
  result.suppressed_alignment_findings = suppressUnsupportedAlignment(
    result,
    capture.deterministicBlockers,
    capture.regions,
  );
  const mergedBlockers = new Set<string>([
    ...(result.blocking_findings ?? []),
    ...capture.deterministicBlockers,
  ]);
  result.blocking_findings = [...mergedBlockers];
  result.deterministic_blocking_findings = capture.deterministicBlockers;
  result.geometry = capture.geometry;
  result.harvest_source = capture.harvestSource;
  if (capture.surface) result.surface = capture.surface;
  if (capture.regions.length > 0) result.regions_declared = capture.regions.map((r) => r.id);

  // The model's own `overall.score` is anchored noise: three judge runs over
  // byte-identical captures returned 72/72/72 while their blocker counts were
  // 2/0/3. Derive a reproducible composite from the axes + findings instead, and
  // keep the model's number only as provenance.
  const anchored = deriveAnchoredScore(result);
  result.capture_hash = captureHash;
  result.capture_unchanged_from_prior = captureUnchanged;
  result.overall = { ...result.overall, score: anchored.score };
  if (anchored.anchored) {
    result.overall.raw_score = anchored.modelScore;
    result.score_derivation = {
      axis_mean: anchored.axisMean,
      penalty: anchored.penalty,
      deterministic_blockers: anchored.deterministicBlockers,
      llm_blockers: anchored.llmBlockers,
      model_reported_score: anchored.modelScore,
    };
  }

  // NEW vs RECURRING trajectory against the most recent prior review for this surface.
  const priorKeys = loadPriorFindingKeys(
    opts.outputDir,
    opts.screenshotName,
    `${opts.screenshotName}-${stamp}.review.json`,
  );
  if (priorKeys) {
    result.finding_trajectory = diffFindings(priorKeys, result.blocking_findings);
  }

  // Art-review mode: (1) drop any asset_findings the model still returned for an
  // already-ledgered asset, (2) merge NEW needs_regen findings into the ledger
  // (suppressed on the next run), and (3) write the labeled GOOD/BAD evidence
  // corpus for this round.
  if (opts.artReview && ledger && artLedgerPath) {
    const suppressed = suppressedAssetKeys(ledger);
    result.suppressed_ledger_assets = [...suppressed];
    if (Array.isArray(result.asset_findings)) {
      result.asset_findings = result.asset_findings.filter(
        (f) => typeof f?.asset !== 'string' || !suppressed.has(normalizeAssetKey(f.asset)),
      );
    }
    // Belt-and-suspenders: a queued asset must not be re-critiqued through ANY
    // finding array, not just the structured asset_findings. The vision model still
    // re-mentions a ledgered asset in free-text prose (and could re-FAIL the gate
    // via blocking_findings), so drop any blocking finding / recommended fix /
    // precise fix that references a suppressed asset. Deterministic blockers are
    // NEVER dropped — they are geometry/pixel checks, not art-pixel critiques.
    let suppressedTextFindings = 0;
    if (Array.isArray(result.blocking_findings)) {
      const deterministic = new Set(result.deterministic_blocking_findings ?? []);
      const before = result.blocking_findings.length;
      result.blocking_findings = result.blocking_findings.filter(
        (f) => deterministic.has(f) || !findingTextReferencesSuppressedAsset(f, suppressed),
      );
      suppressedTextFindings += before - result.blocking_findings.length;
    }
    if (Array.isArray(result.recommended_fixes)) {
      const before = result.recommended_fixes.length;
      result.recommended_fixes = result.recommended_fixes.filter(
        (f) => !findingTextReferencesSuppressedAsset(f, suppressed),
      );
      suppressedTextFindings += before - result.recommended_fixes.length;
    }
    if (Array.isArray(result.precise_fixes)) {
      const before = result.precise_fixes.length;
      result.precise_fixes = result.precise_fixes.filter(
        (f) =>
          !findingTextReferencesSuppressedAsset(
            `${f?.element ?? ''} ${f?.action ?? ''} ${f?.reason ?? ''}`,
            suppressed,
          ),
      );
      suppressedTextFindings += before - result.precise_fixes.length;
    }
    result.suppressed_text_finding_count = suppressedTextFindings;
    const added = mergeAssetFindingsIntoLedger(ledger, result.asset_findings ?? [], isoNow);
    result.ledger_added = added.map((a) => a.asset);
    saveArtLedger(artLedgerPath, ledger);
    if (added.length > 0) {
      console.log(
        `[visual-review-agent] art-regen ledger: +${added.length} new (${added
          .map((a) => a.asset)
          .join(', ')}); ${ledger.assets.length} total queued -> ${artLedgerPath}`,
      );
    } else {
      console.log(
        `[visual-review-agent] art-regen ledger: no new assets (${ledger.assets.length} queued, ${suppressed.size} suppressed this run) -> ${artLedgerPath}`,
      );
    }
  }

  writeFileSync(reviewPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  printResult(result, screenshotPath, reviewPath);

  if (opts.lineageScenario && opts.lineageState) {
    const lineageDir = resolve(opts.outputDir, opts.lineageSide, opts.lineageState);
    mkdirSync(lineageDir, { recursive: true });
    const lineagePng = resolve(lineageDir, `${opts.lineageScenario}.png`);
    const lineageJson = resolve(lineageDir, `${opts.lineageScenario}.review.json`);
    copyFileSync(screenshotPath, lineagePng);
    copyFileSync(reviewPath, lineageJson);
    console.log(
      `[visual-review-agent] lineage: ${opts.lineageSide}/${opts.lineageState}/${opts.lineageScenario}.{png,review.json}`,
    );
  }

  if (opts.artReview && evidenceBundleDir) {
    const dir = writeEvidenceBundle({
      bundleDir: evidenceBundleDir,
      stamp,
      isoNow,
      uxName: opts.uxName,
      uxGoal: opts.uxGoal,
      screenshotPath,
      score: anchored.score,
      result,
      regions: capture.evidenceRegions,
    });
    console.log(`[visual-review-agent] evidence bundle: ${dir}`);
  }

  const score = anchored.score;
  const blockers = result.blocking_findings ?? [];
  if (score < opts.minScore || blockers.length > 0) {
    console.error(
      `[visual-review-agent] FAILED quality gate (score ${score.toFixed(1)} < ${opts.minScore} or blockers=${blockers.length}).`,
    );
    return 1;
  }
  console.log('[visual-review-agent] PASS.');
  return 0;
}

if (process.argv[1] && basename(process.argv[1]) === basename(fileURLToPath(import.meta.url))) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[visual-review-agent] ${message}`);
      process.exit(1);
    });
}
