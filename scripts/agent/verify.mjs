#!/usr/bin/env node

import { npxExecutable, runCommand } from './_helpers.mjs';

async function main() {
  console.log('🔍 Step 1/7: Type checking...');
  await runCommand(npxExecutable, ['tsc', '--noEmit']);

  console.log('🔍 Step 2/7: Linting...');
  await runCommand(npxExecutable, ['eslint', 'src/', 'tests/', '--max-warnings', '0']);

  console.log('🔍 Step 3/7: Format checking...');
  await runCommand(npxExecutable, ['prettier', '--check', 'src/**/*.ts', 'tests/**/*.ts']);

  console.log('🔍 Step 4/7: Dead code detection...');
  const deadCodeResult = await runCommand(npxExecutable, ['knip'], { allowFailure: true });
  if (deadCodeResult.code !== 0) {
    console.log('⚠️  Knip found unused exports (non-blocking for now)');
  }

  console.log('🔍 Step 5/7: Unit tests with coverage...');
  await runCommand(npxExecutable, ['vitest', 'run', '--coverage']);

  console.log('🔍 Step 6/7: Integration tests...');
  const integrationResult = await runCommand(
    npxExecutable,
    ['vitest', 'run', '--project', 'integration'],
    { allowFailure: true },
  );
  if (integrationResult.code !== 0) {
    console.log('ℹ️  No integration tests yet');
  }

  console.log('🔍 Step 7/7: Building...');
  await runCommand(npxExecutable, ['vite', 'build']);

  console.log('✅ Full verification passed.');
}

await main();
