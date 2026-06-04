#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const systemsDir = path.join(repoRoot, 'src', 'core', 'systems');
const labsDir = path.join(repoRoot, 'src', 'labs');

function toLabName(systemFile) {
  return path.basename(systemFile, '.ts').replace(/System$/, '').toLowerCase();
}

async function directoryNames(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name.replace(/-lab$/, '').toLowerCase());
}

async function main() {
  console.log('🔬 Lab Gate Check: Verifying every system has a lab...');

  try {
    await fs.access(systemsDir);
  } catch {
    console.log('ℹ️  No systems directory yet. Skipping lab gate check.');
    return;
  }

  const systemEntries = await fs.readdir(systemsDir, { withFileTypes: true });
  const labNames = new Set(await directoryNames(labsDir));
  let failed = false;

  for (const entry of systemEntries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === 'index.ts') {
      continue;
    }

    const systemName = toLabName(entry.name);
    if (labNames.has(systemName)) {
      console.log(`✅ System '${path.basename(entry.name, '.ts')}' → lab found`);
      continue;
    }

    console.log(`❌ System '${path.basename(entry.name, '.ts')}' has no lab! Expected: src/labs/${systemName}-lab/`);
    failed = true;
  }

  if (failed) {
    console.log('');
    console.log('❌ Lab gate check FAILED. Every system in src/core/systems must have a lab in src/labs.');
    console.log('   Create the lab before shipping the system.');
    process.exitCode = 1;
    return;
  }

  console.log('✅ Lab gate check passed.');
}

await main();
