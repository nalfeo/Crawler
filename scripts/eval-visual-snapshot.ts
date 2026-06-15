import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'url';
import { AzureOpenAIVisionProvider } from './sprites/provider/azure-vision.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load env
try {
  const envPath = resolve(
    process.env.USERPROFILE || process.env.HOME || '',
    '.copilot/session-state/f7220956-761b-43c9-86f5-7698a3e3cf46/files/azure-sprite-pipeline.env',
  );
  const content = readFileSync(envPath, 'utf8');
  for (let line of content.split('\n')) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && match[1]) {
      process.env[match[1]] = match[2];
    }
  }
} catch (_err) {
  console.warn('Could not load azure-sprite-pipeline.env. Ensure env vars are set.');
}

async function run() {
  console.log('Starting Playwright...');
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  const port = process.env.SNAPSHOT_PORT || '3003';
  const url = `http://localhost:${port}/lab.html?lab=visual-snapshot-lab`;
  console.log(`Navigating to ${url}`);
  await page.goto(url);

  // Wait for it to render
  await page.waitForTimeout(3000);

  const screenshotPath = resolve(
    __dirname,
    '..',
    'src',
    'labs',
    'visual-snapshot-lab',
    'visual-snapshot.png',
  );
  await page.screenshot({ path: screenshotPath });
  console.log(`Saved screenshot to ${screenshotPath}`);

  await browser.close();

  console.log('Sending to Azure Vision for evaluation...');
  const provider = new AzureOpenAIVisionProvider({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    deployment:
      process.env.AZURE_OPENAI_VISION_DEPLOYMENT || process.env.AZURE_OPENAI_DEPLOYMENT || '',
    apiKey: process.env.AZURE_OPENAI_API_KEY || '',
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-02-15-preview',
  });

  const prompt = `You are a STRICT senior pixel-art director reviewing a top-down dungeon scene
for a commercial game. Hold it to the bar of a shipped modern pixel game (Terraria,
Stardew Valley, Enter the Gungeon). Do NOT give credit for effort or for being a
"prototype". Score what you actually see. Most amateur output should land at 2-3.

The scene should contain a walled room with a tiled floor, an OPEN door (you can see
the passage/threshold through it), a CLOSED door, a hero, an NPC, a slime, a small
vermin creature, and a glowing fireball.

Be ruthless. Deduct heavily (cap the axis at 2) for ANY of these defects:
- Floor tiles that are all identical with zero variation, or that show obvious
  repeating seams / a grid of hard lines.
- Walls that do not look like solid blocks: visible banding/stripes, a vertical wall
  reusing a horizontal tile, broken or missing corners, or BLACK GAPS between the wall
  and the adjacent floor.
- An "open" door that is just a frame stuck on a wall with no visible passage, or that
  reads identically to the closed door.
- Mobs/characters that are unrecognizable blobs (e.g. a "rat" or "slime" you could not
  identify without the label), or that look like a 1991 / NES-era game.
- A fireball that is just a flat dot with no glow, or indistinguishable from the floor.
- Overall incoherent art where tiles/sprites clearly come from clashing styles.

Award 4 only if the axis is genuinely clean and would not embarrass a hobbyist release.
Award 5 only if it looks professionally cohesive and intentional.

Evaluate the attached snapshot on these axes (integer 1-5):
1. tiling: Do floor tiles vary believably and tile seamlessly, AND do walls form a
   solid bordered room with correct edges/corners and no black gaps?
2. style: Does the whole scene read as one cohesive, modern pixel-art game?
3. readability: Are the hero, NPC, slime, vermin, both doors, and the fireball each
   individually recognizable at a glance and distinct from the floor?
4. overall_quality: Holistic verdict vs. a shipped modern pixel game.

For each axis give a concrete, specific rationale naming exactly what you see (good and
bad). Output ONLY this JSON:
{
  "tiling": { "score": number, "rationale": "string" },
  "style": { "score": number, "rationale": "string" },
  "readability": { "score": number, "rationale": "string" },
  "overall_quality": { "score": number, "rationale": "string" }
}`;

  try {
    const imageData = readFileSync(screenshotPath);
    const resultJson = await provider.evaluate({
      systemInstructions: 'You are an expert art evaluator.',
      userPrompt: prompt,
      images: [
        {
          png: imageData,
          label: 'screenshot',
        },
      ],
    });
    console.log('\n--- EVALUATION RESULT ---');
    console.log(resultJson.json);
  } catch (_err) {
    console.error('Evaluation failed:', _err);
  }
}

run().catch(console.error);
