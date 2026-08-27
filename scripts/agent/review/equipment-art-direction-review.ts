#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { AzureOpenAIVisionProvider } from '../../sprites/provider/azure-vision.js';
import {
  buildArtDirectionPrompt,
  discoverEquipmentCaptures,
  neutralEquipmentScenario,
  normalizeArtDirectionReview,
  summarizeArtDirectionReviews,
} from './equipment-art-direction-lib.mjs';

const DEFAULT_ROOT = 'files/visual-review/after';
const CONTRACT_RETRY_LIMIT = 2;

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

function parseArgs(argv: string[]): { root: string; output: string } {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag !== '--root' && flag !== '--output') throw new Error(`unknown argument: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  return {
    root: values.get('--root') ?? DEFAULT_ROOT,
    output: values.get('--output') ?? 'files/visual-review/equipment-art-direction-batch.json',
  };
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const batchPath = resolve(options.output);
  mkdirSync(dirname(batchPath), { recursive: true });
  const captures = discoverEquipmentCaptures(resolve(options.root));
  if (captures.length === 0) throw new Error(`no equipment captures found under ${options.root}`);
  const deployment = (
    process.env.AZURE_OPENAI_VISION_DEPLOYMENT ??
    process.env.AZURE_OPENAI_DEPLOYMENT ??
    ''
  ).trim();
  if (!deployment) {
    throw new Error(
      'missing required env var AZURE_OPENAI_VISION_DEPLOYMENT (or AZURE_OPENAI_DEPLOYMENT)',
    );
  }
  const provider = new AzureOpenAIVisionProvider({
    endpoint: readEnv('AZURE_OPENAI_ENDPOINT'),
    apiKey: readEnv('AZURE_OPENAI_API_KEY'),
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() || '2024-02-15-preview',
  });
  const reviews: Array<Record<string, unknown>> = [];
  for (const capture of captures) {
    const scenario = neutralEquipmentScenario(capture.version);
    const prompt = buildArtDirectionPrompt(scenario);
    const output = capture.image.replace(/\.png$/i, '.art-direction.review.json');
    try {
      const image = readFileSync(capture.image);
      let result: ReturnType<typeof normalizeArtDirectionReview> | undefined;
      let contractError = '';
      for (let attempt = 0; attempt <= CONTRACT_RETRY_LIMIT; attempt += 1) {
        const retrySystemInstructions =
          attempt === 0
            ? prompt.system
            : `${prompt.system}

The prior response violated a hard output contract: ${contractError}
Do not repeat or paraphrase that forbidden claim. If it was the only possible criticism for a pillar, report no material concern visible and preserve the current treatment.`;
        const retryInstruction =
          attempt === 0
            ? prompt.user
            : `${prompt.user}

Your previous JSON was rejected for this contract violation:
${contractError}

Correct that violation without inventing an alternative defect. Return the exact requested JSON shape only.`;
        const response = await provider.evaluate({
          systemInstructions: retrySystemInstructions,
          userPrompt: retryInstruction,
          images: [{ label: `${capture.version} Equipment`, png: image }],
          temperature: 0,
          maxTokens: 2600,
        });
        try {
          result = normalizeArtDirectionReview(response.json, {
            image: capture.image,
            scenario,
            modelDeployment: response.modelDeployment,
          });
          break;
        } catch (error) {
          contractError = error instanceof Error ? error.message : String(error);
          if (attempt === CONTRACT_RETRY_LIMIT) throw error;
        }
      }
      if (!result) throw new Error('review did not produce a normalized result');
      writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      reviews.push({
        version: capture.version,
        image: capture.image,
        output,
        status: 'completed',
        result,
      });
      console.log(`[equipment-art-direction] ${capture.version}: completed -> ${output}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reviews.push({
        version: capture.version,
        image: capture.image,
        output,
        status: 'failed',
        error: message,
      });
      console.error(`[equipment-art-direction] ${capture.version}: failed — ${message}`);
    }
  }
  const batch = {
    schemaVersion: 1,
    kind: 'equipment-art-direction-batch',
    generatedAt: new Date().toISOString(),
    reviews,
    summary: summarizeArtDirectionReviews(reviews),
  };
  writeFileSync(batchPath, `${JSON.stringify(batch, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ output: batchPath, summary: batch.summary }));
  if (batch.summary.failed > 0) process.exitCode = 1;
}

if (process.argv[1]?.endsWith('equipment-art-direction-review.ts')) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
