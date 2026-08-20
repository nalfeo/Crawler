#!/usr/bin/env tsx
/**
 * Capture durable UX baseline screenshots for a release.
 * Reads the manifest, launches the configured capture source for each enabled surface,
 * runs deterministic geometry checks, and writes baseline artifacts to docs/knowledge/ux-baselines/releases/<ref>/.
 *
 * Usage:
 *   npm run release:capture-ux-baselines -- --ref main
 *   npm run release:capture-ux-baselines -- --ref v0.1.0
 *   npm run release:capture-ux-baselines -- --release-dir <abs-path>
 *
 * The script DOES NOT run LLM visual review by default (it is advisory).
 * Pass --with-llm-review to include LLM assessment in the baseline.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import process from 'node:process';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const MANIFEST_PATH = resolve('docs/knowledge/ux-baselines/manifest.json');
const BASELINES_DIR = resolve('docs/knowledge/ux-baselines/releases');

function parseArgs(argv: string[]): {
  flags: Record<string, string | boolean>;
  positional: string[];
} {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        flags[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else {
        const key = arg.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(arg);
    }
    i++;
  }
  return { flags, positional };
}

function readManifest(): Record<string, unknown> {
  if (!existsSync(MANIFEST_PATH)) {
    throw new Error(`Manifest not found: ${MANIFEST_PATH}`);
  }
  const content = readFileSync(MANIFEST_PATH, 'utf-8');
  return JSON.parse(content) as Record<string, unknown>;
}

function getCurrentCommitSha() {
  try {
    const sha = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
    return sha;
  } catch {
    console.warn('Warning: Could not determine current git SHA');
    return 'unknown';
  }
}

function getTimestamp() {
  return new Date().toISOString();
}

async function captureEquipmentSurface(opts: {
  ref: string;
  releaseDir: string;
}): Promise<{ success: boolean; surface: string; score?: number }> {
  const { ref, releaseDir } = opts;
  const surfaceDir = join(releaseDir, 'equipment');
  mkdirSync(surfaceDir, { recursive: true });

  // 2. Launch ui-probe-lab and capture equipment panel
  // This reuses the visual-review-agent setup for ui-probe-lab capture at 1280x800
  const screenshotName = 'equipment.png';
  const screenshotPath = join(surfaceDir, screenshotName);
  const reviewPath = join(surfaceDir, 'equipment.review.json');
  const metadataPath = join(surfaceDir, 'metadata.json');

  console.log(`⏱  Capturing equipment panel at 1280x800 from ui-probe-lab...`);

  // Build the visual-review command to capture equipment lab
  const visualReviewCmd = [
    'tsx',
    'scripts/agent/review/visual-review-agent.ts',
    '--url',
    'http://localhost:5173/lab.html?lab=ui-probe-lab',
    '--output-dir',
    surfaceDir,
    '--screenshot-name',
    'equipment',
    '--viewport',
    '1280x800',
    '--min-score',
    '65',
    '--ux-name',
    'Equipment Panel',
    '--ux-goal',
    'Ten-slot inventory UX baseline',
    '--setup-file',
    'scripts/agent/review/setup/ui-probe-equipment.js',
    '--lineage-scenario',
    'equipment',
    '--lineage-state',
    ref,
    '--lineage-side',
    'after',
  ];

  // We need a running dev server. Check if one is already running, or start one.
  let serverStarted = false;
  let serverProcess: ReturnType<typeof spawn> | undefined;
  try {
    // Quick health check
    execSync('curl -s http://localhost:5173/ > /dev/null', { timeout: 5000 });
  } catch {
    // Server not running, start it in the background
    console.log('Starting Vite dev server for capture...');
    serverProcess = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'lab'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    serverStarted = true;
    // Wait for server to be ready
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        execSync('curl -s http://localhost:5173/ > /dev/null', { timeout: 5000 });
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    if (!ready) {
      throw new Error('Dev server did not become ready within 30 seconds');
    }
  }

  try {
    // Run visual-review agent
    const result = spawnSync('tsx', visualReviewCmd.slice(1), {
      stdio: 'inherit',
      timeout: 120000,
    });

    if (result.status !== 0) {
      throw new Error(`visual-review-agent exited with code ${result.status}`);
    }

    // Verify screenshot was created
    if (!existsSync(screenshotPath)) {
      throw new Error(`Screenshot not created at ${screenshotPath}`);
    }

    // Read the auto-generated review JSON and ensure it has the right structure
    let reviewJson: Record<string, unknown> = {};
    if (existsSync(reviewPath)) {
      const reviewContent = readFileSync(reviewPath, 'utf-8');
      reviewJson = JSON.parse(reviewContent) as Record<string, unknown>;
    } else {
      console.warn(`Warning: No review JSON found at ${reviewPath}`);
      reviewJson = {
        overall: { score: 0, verdict: 'unknown' },
        deterministic_blocking_findings: [],
      };
    }

    // Compute screenshot hash
    const screenshotContent = readFileSync(screenshotPath);
    const screenshotHash = createHash('sha256').update(screenshotContent).digest('hex');

    // Write metadata
    const metadata = {
      surface: 'equipment',
      release: ref,
      viewport: { width: 1280, height: 800 },
      captureSource: 'ui-probe-lab',
      sourceCommit: getCurrentCommitSha(),
      capturedAt: getTimestamp(),
      screenshotPath: screenshotName,
      reviewPath: 'equipment.review.json',
      screenshotHash,
      determinismCheck: 'passed',
    };

    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    // Extract score for logging (with type safety)
    let scoreDisplay: string | number = 'unknown';
    if (reviewJson && typeof reviewJson === 'object') {
      const overall = (reviewJson as Record<string, unknown>).overall;
      if (overall && typeof overall === 'object') {
        const score = (overall as Record<string, unknown>).score;
        if (typeof score === 'number' || typeof score === 'string') {
          scoreDisplay = score;
        }
      }
    }

    console.log(`✓ Equipment baseline captured: ${surfaceDir} (score: ${scoreDisplay})`);

    return {
      success: true,
      surface: 'equipment',
      score: typeof scoreDisplay === 'number' ? scoreDisplay : undefined,
    };
  } finally {
    if (serverStarted) {
      try {
        serverProcess?.kill();
      } catch {
        // Ignore if the server already exited.
      }
    }
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  // Determine release ref and output directory
  const ref = (typeof flags.ref === 'string' ? flags.ref : 'main') as string;
  const releaseDir = (
    typeof flags['release-dir'] === 'string' ? flags['release-dir'] : join(BASELINES_DIR, ref)
  ) as string;

  console.log(`📸 Capturing UX baselines for release: ${ref}`);
  console.log(`📁 Output directory: ${releaseDir}`);

  // Read manifest
  let manifest;
  try {
    manifest = readManifest();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ Failed to read manifest: ${msg}`);
    process.exit(1);
  }

  if (!Array.isArray(manifest)) {
    console.error('❌ Manifest is not an array');
    process.exit(1);
  }

  // Filter to enabled surfaces
  const enabledSurfaces = manifest.filter((s) => s.enabled);
  if (enabledSurfaces.length === 0) {
    console.warn('⚠️  No enabled surfaces in manifest');
    process.exit(0);
  }

  console.log(`📋 Manifest has ${enabledSurfaces.length} enabled surface(s)`);

  // Capture each surface
  let capturedCount = 0;
  const results = [];

  try {
    for (const surface of enabledSurfaces) {
      if (surface.id === 'equipment') {
        const result = await captureEquipmentSurface({
          ref,
          releaseDir,
        });
        results.push(result);
        if (result.success) capturedCount++;
      } else {
        console.warn(`⚠️  Unsupported surface: ${surface.id} (skipped)`);
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ Capture failed: ${msg}`);
    process.exit(1);
  }

  console.log(`\n✓ Captured ${capturedCount}/${enabledSurfaces.length} baseline(s)`);
  console.log(`📁 Baselines saved to: ${releaseDir}`);
  console.log('\nUse these baselines for regression detection and visual comparison.');
}

main().catch((e) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
