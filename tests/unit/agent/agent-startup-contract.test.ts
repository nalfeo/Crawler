import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  MAX_STARTUP_CONTRACT_CHARS,
  checkStartupContract,
  formatStartupContractReport,
} from '../../../scripts/agent/docs/check-agent-startup-contract.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/agent-startup-contract',
);
const fixture = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8');

describe('agent startup contract guard', () => {
  it('accepts a compact contract and reports its explicit ceiling', () => {
    const result = checkStartupContract(fixture('compact.md'));
    expect(result.failures).toEqual([]);
    expect(formatStartupContractReport(result)).toContain(
      `/${MAX_STARTUP_CONTRACT_CHARS} characters`,
    );
  });

  it('rejects a contract over the startup-context ceiling', () => {
    const result = checkStartupContract(
      fixture('oversize.md').repeat(Math.ceil((MAX_STARTUP_CONTRACT_CHARS + 1) / 81)),
    );
    expect(result.characterCount).toBeGreaterThan(MAX_STARTUP_CONTRACT_CHARS);
    expect(result.failures).toContain(
      `root startup contract is ${result.characterCount} characters; maximum is ${MAX_STARTUP_CONTRACT_CHARS}.`,
    );
  });

  it('rejects mandatory bulk-reading language', () => {
    expect(checkStartupContract(fixture('mandatory-bulk-read.md')).failures).toContain(
      'root startup contract contains prohibited mandatory bulk-reading instruction.',
    );
  });
});
