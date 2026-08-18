#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { AzureOpenAIVisionProvider } from '../../sprites/provider/azure-vision.js';
import {
  assertAdvisoryThresholds,
  buildPrompt,
  mediaTypeFor,
  normalizeReview,
  parseArgs,
  parseMetadataText,
} from './arbitrary-screenshot-lib.mjs';

function readEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

export async function run(argv = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(argv);
  const image = resolve(options.image);
  const metadata = options.metadata
    ? parseMetadataText(readFileSync(resolve(options.metadata), 'utf8'))
    : {};
  const deployment = (
    process.env.AZURE_OPENAI_VISION_DEPLOYMENT ??
    process.env.AZURE_OPENAI_DEPLOYMENT ??
    ''
  ).trim();
  if (!deployment)
    throw new Error(
      'missing required env var AZURE_OPENAI_VISION_DEPLOYMENT (or AZURE_OPENAI_DEPLOYMENT)',
    );
  const provider = new AzureOpenAIVisionProvider({
    endpoint: readEnv('AZURE_OPENAI_ENDPOINT'),
    apiKey: readEnv('AZURE_OPENAI_API_KEY'),
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION?.trim() || '2024-02-15-preview',
  });
  const prompt = buildPrompt(metadata);
  const response = await provider.evaluate({
    systemInstructions: prompt.system,
    userPrompt: prompt.user,
    images: [{ label: basename(image), png: readFileSync(image), mediaType: mediaTypeFor(image) }],
    temperature: 0,
    maxTokens: 2600,
  });
  const result = normalizeReview(response.json, {
    image,
    metadata,
    modelDeployment: response.modelDeployment,
  });
  const output = resolve(options.output ?? `files/visual-review/${basename(image)}.review.json`);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  assertAdvisoryThresholds(result, options);
  console.log(
    JSON.stringify({
      output,
      score: result.score,
      coverage: result.coverage,
      hardFailures: result.hardFailures.length,
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
