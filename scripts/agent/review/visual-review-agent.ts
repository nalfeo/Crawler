#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright';
import { AzureOpenAIVisionProvider } from '../../sprites/provider/azure-vision.js';

interface CliOptions {
  labUrl: string;
  outputDir: string;
  minScore: number;
  uxName: string;
  uxGoal: string;
  setupFile: string | null;
  screenshotName: string;
  waitMs: number;
  clip: { x: number; y: number; width: number; height: number } | null;
  /**
   * Author rebuttals to prior findings, each a self-contained line. Injected
   * into the prompt so the judge must reconcile them against the measured
   * geometry and issue a FINAL verdict (defend with numbers or withdraw).
   */
  rebuttals: string[];
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

interface VisualReviewResult {
  overall?: {
    score?: number;
    verdict?: string;
    summary?: string;
  };
  axes?: Record<string, VisualAxis>;
  blocking_findings?: string[];
  recommended_fixes?: string[];
  precise_fixes?: PreciseFix[];
  deterministic_blocking_findings?: string[];
  geometry?: GeometrySnapshot;
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

interface CaptureResult {
  deterministicBlockers: string[];
  geometry: GeometrySnapshot;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    labUrl: 'http://127.0.0.1:4176/lab.html?lab=ui-probe-lab',
    outputDir: resolve(process.cwd(), 'files', 'visual-review'),
    minScore: 4,
    uxName: 'equipment + inventory character panel',
    uxGoal:
      'clear slot layout, readable typography, strong hierarchy, coherent spacing, icon-first item representation',
    setupFile: null,
    screenshotName: 'ux-surface',
    waitMs: 350,
    clip: null,
    rebuttals: [],
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
      if (!Number.isFinite(score) || score < 1 || score > 5) {
        throw new Error(`invalid --min-score "${next}" (expected 1..5)`);
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
    if (arg === '--setup-file' && next) {
      opts.setupFile = resolve(process.cwd(), next);
      i += 1;
      continue;
    }
    if (arg === '--screenshot-name' && next) {
      opts.screenshotName = next.trim().replace(/[^a-zA-Z0-9_-]+/g, '-');
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

function buildPrompt(
  opts: Pick<CliOptions, 'uxName' | 'uxGoal' | 'rebuttals'>,
  geometryText: string,
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
  return {
    system: `You are a brutally honest senior game UI art director.
Evaluate ONLY what is visible in the screenshot and output strict JSON.
Do not excuse prototype quality. Call out spacing, overlap, alignment, hierarchy, typography, icon usage, text breathing-room, and readability defects explicitly.
You are given the exact measured pixel geometry of every element. Use it to make positional feedback concrete and numeric — never vague.
The measured geometry is AUTHORITATIVE: when a claim about a pixel gap, overlap, or alignment conflicts with the geometry numbers, trust the numbers, not your visual impression.`,
    user: `Review the attached screenshot of Crawler's "${opts.uxName}" UX surface.
Design intent for this surface: ${opts.uxGoal}.

MEASURED LAYOUT GEOMETRY (layout pixels, origin top-left; this is the SAME layout shown in the screenshot, so relative positions and pixel deltas are exact and directly actionable):
${geometryText}${rebuttalBlock}

Score each axis 1-5 (1 = unacceptable, 5 = shippable quality):
- layout_consistency
- spacing_balance
- visual_hierarchy
- readability
- icon_usage
- typography_clarity
- thematic_fidelity

Typography spacing standard is strict:
- Every text block must have visible top/bottom breathing room inside its container.
- Flag cramped text when cap-height/ascenders sit too close to borders, dividers, or neighboring rows.

Readability and affordance standards are strict:
- Pixel-font text must look crisp (no blurry/soft downscaled look).
- Stat labels must be human-readable words (e.g., "CRIT CHANCE"), not raw camelCase/PascalCase identifiers.
- Empty slots must expose slot identity/help affordance (in this capture an empty-slot tooltip should be visible).
- Slot tiles should be roughly square or portrait; very short/wide slot boxes are a defect.
- Slot tiles must have visible breathing room; touching box edges between neighbors is a defect.
- Sprites should occupy most of slot interior; large dead padding around icons is a defect.
- Empty-state cues must be explicit and readable; punctuation placeholders like "?" or "_" are not acceptable primary indicators.
- Section labels (e.g., PRIMARY/SECONDARY) must not have decorative lines crossing through glyphs.
- Tooltip surfaces must render above nearby elements and remain fully readable.

Thematic standard is strict: this is a **pixel dungeon crawler** UX.
If the UI reads as generic modern app chrome (flat/sterile panels, non-dungeon mood, weak pixel-art identity),
score thematic_fidelity <= 2 and include it as a blocking finding.

Hard requirements:
- Name specific concrete defects (exact panel/slot/area) in issues.
- If any overlap, clipping, misalignment, or unreadable text exists, include it in blocking_findings.
- If text appears cramped (insufficient top padding/line breathing room), include it in blocking_findings.
- If stat labels appear as code-style camelCase/PascalCase, include it in blocking_findings.
- If text appears blurry/soft rather than crisp pixel text, include it in blocking_findings.
- If empty-slot tooltip affordance is missing/unclear in the capture, include it in blocking_findings.
- If slot aspect ratio or icon occupancy harms item readability, include it in blocking_findings.
- If slot boxes touch each other with no breathing room, include it in blocking_findings.
- If any section label has line-through/intersecting divider artifacts, include it in blocking_findings.
- If placeholder punctuation is used as the primary empty-slot indicator, include it in blocking_findings.
- If tooltip layering/clipping makes tooltip text hard to read, include it in blocking_findings.
- If visual theming feels generic and not like a pixel dungeon crawler, include it in blocking_findings.
- recommended_fixes must be actionable and ordered by impact.

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
  ]
}`,
  };
}

async function captureScreenshot(
  opts: Pick<CliOptions, 'labUrl' | 'setupFile' | 'waitMs' | 'clip'>,
  outPath: string,
): Promise<CaptureResult> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  await page.goto(opts.labUrl, { waitUntil: 'commit', timeout: 45_000 });
  await page.waitForFunction(
    () => {
      const globalWithProbe = window as unknown as {
        __uiProbe?: { ready?: () => boolean };
      };
      return globalWithProbe.__uiProbe?.ready?.() === true;
    },
    { timeout: 45_000 },
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
        'head','face','neck','shoulders','chest','back','leftArm','rightArm',
        'leftWrist','rightWrist','mainHand','offHand','gloves','ringLeft','ringRight',
        'belt','legs','feet'
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

  await context.close();
  await browser.close();
  return { deterministicBlockers, geometry };
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

function printResult(result: VisualReviewResult, screenshotPath: string, reviewPath: string): void {
  const score = result.overall?.score ?? 0;
  const verdict = result.overall?.verdict ?? 'fail';
  const summary = result.overall?.summary ?? 'no summary returned';
  const blockers = result.blocking_findings ?? [];

  console.log(`\n[visual-review-agent] verdict=${verdict} score=${score}/5`);
  console.log(`[visual-review-agent] summary: ${summary}`);
  if (blockers.length > 0) {
    console.log('[visual-review-agent] blocking findings:');
    for (const finding of blockers) {
      console.log(`  - ${finding}`);
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

async function main(): Promise<number> {
  if (process.env.CI) {
    console.error('[visual-review-agent] Refusing to run in CI (dev-session tool only).');
    return 2;
  }

  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.outputDir, { recursive: true });
  const stamp = nowStamp();
  const screenshotPath = resolve(opts.outputDir, `${opts.screenshotName}-${stamp}.png`);
  const reviewPath = resolve(opts.outputDir, `${opts.screenshotName}-${stamp}.review.json`);

  const capture = await captureScreenshot(opts, screenshotPath);
  const geo = capture.geometry;
  console.log(
    `[visual-review-agent] geometry captured: panel=${geo.panel ? 'yes' : 'NULL'} ` +
      `tooltip=${geo.tooltip ? 'yes' : 'NULL'} ` +
      `slots=${geo.slots.filter((s) => s.box).length}/${geo.slots.length} with-box`,
  );

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
  const prompt = buildPrompt(opts, formatGeometry(capture.geometry));
  const png = readFileSync(screenshotPath);
  const evaluation = await provider.evaluate({
    systemInstructions: prompt.system,
    userPrompt: prompt.user,
    images: [{ label: 'equipment-ui', png }],
    temperature: 0,
    maxTokens: 1800,
  });

  const result = extractJsonObject(evaluation.json);
  const mergedBlockers = new Set<string>([
    ...(result.blocking_findings ?? []),
    ...capture.deterministicBlockers,
  ]);
  result.blocking_findings = [...mergedBlockers];
  result.deterministic_blocking_findings = capture.deterministicBlockers;
  result.geometry = capture.geometry;
  writeFileSync(reviewPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
  printResult(result, screenshotPath, reviewPath);

  const score = result.overall?.score ?? 0;
  const blockers = result.blocking_findings ?? [];
  if (score < opts.minScore || blockers.length > 0) {
    console.error(
      `[visual-review-agent] FAILED quality gate (score ${score} < ${opts.minScore} or blockers=${blockers.length}).`,
    );
    return 1;
  }
  console.log('[visual-review-agent] PASS.');
  return 0;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[visual-review-agent] ${message}`);
    process.exit(1);
  });
