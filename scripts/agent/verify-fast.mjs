#!/usr/bin/env node

import { npxExecutable, runCommand } from './_helpers.mjs';

async function main() {
  console.log('🔍 Step 1/3: Type checking...');
  await runCommand(npxExecutable, ['tsc', '--noEmit']);

  console.log('🔍 Step 2/3: Linting...');
  await runCommand(npxExecutable, ['eslint', 'src/', 'tests/', '--max-warnings', '0']);

  console.log('🔍 Step 3/3: Unit tests...');
  await runCommand(npxExecutable, ['vitest', 'run', '--project', 'unit', '--reporter=verbose']);

  console.log('✅ Fast verification passed.');
}

await main();
