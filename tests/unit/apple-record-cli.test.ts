import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildAppleRecord,
  parseArgs,
  writeAppleRecordFile,
} from '../../scripts/agent/docs/apple-record-cli.js';

function cliArgs(...args: string[]): string[] {
  return ['node', 'apple-record-cli.js', ...args];
}

describe('apple-record-cli parseArgs', () => {
  it('parses valid args', () => {
    expect(
      parseArgs(cliArgs('--session', 'trim-apple-ritual', '--estimated', '3', '--actual', '4')),
    ).toEqual({
      session: 'trim-apple-ritual',
      estimated: 3,
      actual: 4,
    });
  });

  it('rejects malformed and fractional count values', () => {
    expect(() =>
      parseArgs(cliArgs('--session', 'ok', '--estimated', '3foo', '--actual', '4')),
    ).toThrow(/--estimated must be an integer 1-5/);
    expect(() =>
      parseArgs(cliArgs('--session', 'ok', '--estimated', '3.9', '--actual', '4')),
    ).toThrow(/--estimated must be an integer 1-5/);
    expect(() =>
      parseArgs(cliArgs('--session', 'ok', '--estimated', '3', '--actual', '2.2')),
    ).toThrow(/--actual must be an integer 1-5/);
  });

  it('rejects missing args and invalid slugs', () => {
    expect(() => parseArgs(cliArgs('--session', 'ok', '--estimated', '3'))).toThrow(
      /Missing required flags/,
    );
    expect(() =>
      parseArgs(cliArgs('--session', 'Not-Kebab', '--estimated', '3', '--actual', '3')),
    ).toThrow(/--session must be a kebab-case slug/);
  });
});

describe('apple-record-cli write behavior', () => {
  it('derives entry/path and writes a new record; duplicate paths fail', () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'apple-record-cli-'));
    try {
      const { outPath, entry } = buildAppleRecord(
        {
          date: '2026-07-10',
          session: 'trim-apple-ritual',
          estimated: 3,
          actual: 4,
        },
        tmpDir,
      );

      expect(outPath).toBe(path.join(tmpDir, '2026-07-10-trim-apple-ritual.json'));
      expect(entry).toEqual({
        date: '2026-07-10',
        session: 'trim-apple-ritual',
        estimated_apples: 3,
        actual_apples: 4,
        delta: 1,
        verdict: 'under',
        hello_kitties: 0.8,
      });
      writeAppleRecordFile(outPath, entry);
      expect(JSON.parse(readFileSync(outPath, 'utf8'))).toEqual(entry);
      expect(() => writeAppleRecordFile(outPath, entry)).toThrow(/File already exists/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
