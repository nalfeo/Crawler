/* global console, process */
/**
 * E2E: Junk Rat Critters sprite generation pipeline.
 *
 * Exercises the full sprite workflow using real Azure OpenAI:
 *   1. Synthesize brief candidates  (POST /api/workflow/synthesize, gpt-4o)
 *   2. Promote selected brief        (POST /api/workflow/promote-brief)
 *   3. Generate sprite run           (POST /api/workflow/generate, gpt-image-1)
 *   4. Run metadata pipeline         (POST /api/workflow/metadata, heuristic)
 *   5. Verify gallery via Playwright on this session's derived lab URL
 *
 * Prerequisites:
 *   1. Azure resources + credentials — run
 *      `pwsh scripts/setup-azure-env.ps1 -ProvisionResources -IncludeStorage`
 *   2. Sprite sidecar running (defaults to this session's derived sidecar port):
 *        $env:AZURE_OPENAI_ENDPOINT = ...
 *        $env:AZURE_OPENAI_API_KEY  = ...
 *        $env:AZURE_OPENAI_CHAT_DEPLOYMENT   = gpt-4o
 *        $env:AZURE_OPENAI_IMAGE_DEPLOYMENT  = gpt-image-1
 *        $env:AZURE_OPENAI_VISION_DEPLOYMENT = gpt-4o
 *        npx tsx scripts/sprites/sidecar/cli.ts
 *   3. Vite lab server running on this session's derived lab port:
 *        npm run lab
 *
 * Usage:
 *   node scripts/e2e-junk-rat-sprite.mjs
 *
 * Expected runtime: ~60–120 s (image generation dominates).
 */

import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';
import { getSessionServerPorts } from './shared/session-server-ports.js';

const SESSION_PORTS = getSessionServerPorts({ cwd: process.cwd(), env: process.env });
const SIDECAR = SESSION_PORTS.sidecarBaseUrl;
const GALLERY_URL = `${SESSION_PORTS.labBaseUrl}/lab.html?lab=sprite-gallery`;
const BRIEF_NAME = 'junk-rat-critters';
const BRIEF_TYPE = 'enemy';

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await globalThis.fetch(`${SIDECAR}${path}`, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function main() {
  console.log('🎬 Junk Rat Sprite E2E — full pipeline with real Azure OpenAI\n');

  // 1. Sidecar health check
  const health = await api('GET', '/api/health');
  console.log(`✅ Sidecar up: v${health.version}`);

  // 2. Synthesize brief candidates
  console.log(`\n📝 Step 1: Synthesize brief for '${BRIEF_NAME}' (gpt-4o)...`);
  const synth = await api('POST', '/api/workflow/synthesize', {
    name: BRIEF_NAME,
    type: BRIEF_TYPE,
    candidates: 1,
  });
  console.log(`✅ Synthesized ${synth.written.length} brief(s):`);
  for (const w of synth.written) {
    console.log(`   ${w.id} → ${w.yamlPath}`);
  }

  const firstBrief = synth.written[0];
  if (!firstBrief) throw new Error('Synthesis produced no briefs');

  // 3. Promote brief to draft
  console.log('\n📌 Step 2: Promote brief to draft...');
  const promote = await api('POST', '/api/workflow/promote-brief', {
    sourceYamlPath: firstBrief.yamlPath,
    type: BRIEF_TYPE,
    name: BRIEF_NAME,
    target: 'draft',
  });
  console.log(`✅ Promoted → ${promote.briefPath} (${promote.target})`);

  // 4. Generate sprite run (real gpt-image-1)
  console.log('\n🎨 Step 3: Generate run (gpt-image-1) — 60–120s...');
  const t0 = Date.now();
  const generate = await api('POST', '/api/workflow/generate', {
    briefPath: promote.briefPath,
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const candidateCount = generate.summary?.candidates?.length ?? '?';
  console.log(`✅ Generated ${candidateCount} candidates in ${elapsed}s`);
  console.log(`   briefId: ${generate.briefId}`);
  console.log(`   runId:   ${generate.runId}`);
  console.log(`   runDir:  ${generate.runDir}`);

  // 5. Metadata pipeline
  console.log('\n🏷️  Step 4: Generate metadata (heuristic)...');
  const meta = await api('POST', '/api/workflow/metadata', {
    provider: 'heuristic',
    force: true,
  });
  console.log(`✅ Metadata pipeline complete`);
  console.log(
    `   processed: ${meta.processed ?? 0} | skipped: ${meta.skipped ?? 0} | errors: ${(meta.errors ?? []).length}`,
  );

  // 6. Verify run via sidecar /api/runs
  console.log('\n🔍 Step 5: Verify run appears in sidecar...');
  const { runs } = await api('GET', '/api/runs');
  const newRun = runs.find((r) => r.briefId === generate.briefId && r.runId === generate.runId);
  if (!newRun) throw new Error(`Run ${generate.briefId}/${generate.runId} not in /api/runs`);
  console.log(
    `✅ Run confirmed: ${newRun.briefId}/${newRun.runId} (${newRun.candidateCount} candidates)`,
  );

  // 7. Playwright gallery verification
  console.log('\n🖼️  Step 6: Verify sprite gallery (Playwright)...');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let galleryPassed;

  try {
    await page.goto(GALLERY_URL, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    const content = await page.content();
    galleryPassed = content.includes(BRIEF_NAME);

    mkdirSync('tmp', { recursive: true });
    const screenshotPath = 'tmp/junk-rat-e2e-gallery.png';
    await page.screenshot({ path: screenshotPath, fullPage: true });

    if (galleryPassed) {
      console.log(`✅ '${BRIEF_NAME}' visible in sprite gallery`);
    } else {
      console.warn('⚠️  Gallery loaded but junk-rat entry not yet visible');
    }
    console.log(`📸 Screenshot: ${screenshotPath}`);
  } finally {
    await ctx.close();
    await browser.close();
  }

  if (!galleryPassed) {
    throw new Error('Gallery check failed — junk-rat not visible after pipeline');
  }

  console.log(`\n🎉 E2E PASSED — ${BRIEF_NAME} generated end-to-end with real Azure OpenAI`);
}

main().catch((err) => {
  console.error('\n❌ E2E FAILED:', err.message);
  process.exit(1);
});
