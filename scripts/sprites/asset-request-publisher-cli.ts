#!/usr/bin/env tsx

import { publishSelectedAssetRequests } from './asset-request-publisher.js';
import { createRunStore } from './store/index.js';

const repoRoot = process.cwd();
const env = process.env;

void publishSelectedAssetRequests({
  repoRoot,
  env,
  store: createRunStore({ repoRoot, env }),
})
  .then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  })
  .catch((error) => {
    process.stderr.write(
      `asset-request publisher failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
