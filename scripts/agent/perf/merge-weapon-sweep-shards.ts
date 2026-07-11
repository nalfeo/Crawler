#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeWeaponSweepShards, type WeaponSweepOutput } from './weapon-sweep-results.js';

interface Args {
  inputs: string;
  weapon: string;
  seedCount: number;
  out: string;
}

function parseArgs(): Args {
  const args: Partial<Args> = {};
  for (let index = 2; index < process.argv.length; index += 1) {
    const arg = process.argv[index];
    const next = process.argv[index + 1];
    if (arg === '--inputs' && next) args.inputs = next;
    else if (arg === '--weapon' && next) args.weapon = next;
    else if (arg === '--seed-count' && next) args.seedCount = Number(next);
    else if (arg === '--out' && next) args.out = next;
    else continue;
    index += 1;
  }
  if (!args.inputs || !args.weapon || !args.out || !Number.isInteger(args.seedCount)) {
    throw new Error('Usage: --inputs <dir> --weapon <id> --seed-count <n> --out <file>');
  }
  if (args.seedCount! < 1) {
    throw new Error('--seed-count must be a positive integer');
  }
  return args as Args;
}

function main(): void {
  const args = parseArgs();
  const files = readdirSync(args.inputs)
    .filter((file) => file.endsWith('.json'))
    .sort();
  const shards = files.map(
    (file) => JSON.parse(readFileSync(join(args.inputs, file), 'utf8')) as WeaponSweepOutput,
  );
  const expectedSeeds = Array.from({ length: args.seedCount }, (_, index) => index + 1);
  const merged = mergeWeaponSweepShards(shards, args.weapon, expectedSeeds);
  writeFileSync(args.out, JSON.stringify(merged, null, 2));
  console.log(
    `Merged ${shards.length} shard(s) into ${args.out} (${merged.allRecords.length} runs)`,
  );
}

main();
