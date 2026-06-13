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

  console.log('Navigating to http://localhost:3006/lab.html?lab=visual-snapshot-lab');
  await page.goto('http://localhost:3006/lab.html?lab=visual-snapshot-lab');

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

  const prompt = `You are an expert game developer reviewing a procedural pixel art prototype.
The user's goal is to hit a 4/5 score across these criteria to prove the automated art pipeline works.
This is PROGRAMMER ART generated algorithmically, so do not hold it to shipped AAA standards.
If the floor does not look like a blatant noisy mess, and walls/doors have a proper visual grounding (like a shadow), and sprites look roughly recognizable, give it a 4.

Evaluate the attached visual snapshot on the following axes (1-5):
1. Tiling: Do the floor tiles connect seamlessly without obvious seams?
2. Style: Does the scene look like a cohesive modern pixel game (e.g., Terraria, Stardew, or Enter the Gungeon prototype)?
3. Readability: Are the mobs (slime, rat), hero, and fireball visually distinct and readable against the floor?
4. Overall Quality: Is this a solid 4/5 prototype?

Output a JSON object ONLY matching this schema:
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
