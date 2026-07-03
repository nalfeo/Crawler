/**
 * Seed one approved, weapon-typed generated sprite (plus its manifest entry)
 * under `<root>/public/assets/generated/`.
 *
 * Generation now sends OUR own approved sprites as `images/edits` references
 * (Kenney placeholder spritesheets are retired), so the reference selector in
 * `generateSheetCore` requires at least one eligible, same-type, on-disk entry.
 * Every integration test that drives the real `runFull` / `generateSheetCore`
 * pipeline against a `weapon` brief therefore needs this seed, otherwise
 * generation fails closed with "no eligible generated reference sprites".
 *
 * The entry mirrors `tests/integration/synth-to-generate.test.ts`: it clears
 * the sensor (4/4) and judge (5) floors, is typed `weapon`, and its `briefId`
 * differs from the briefs under test so it is never self-excluded.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildGoodSwordFixture } from './builders.js';

export function seedGeneratedReference(root: string): void {
  const generatedDir = path.join(root, 'public', 'assets', 'generated');
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(path.join(generatedDir, 'ref-weapon-example.png'), buildGoodSwordFixture());
  writeFileSync(
    path.join(generatedDir, 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'ref-weapon-example-v1': {
          briefId: 'ref-weapon-example',
          spriteName: 'ref-weapon-example-v1',
          assetPath: 'generated/ref-weapon-example.png',
          approvedAt: '2026-06-05T00:00:00.000Z',
          sourceRun: 'run-ref-weapon-example',
          variantIndex: 0,
          anchor: { x: 8, y: 14, source: 'derived' },
          sensorScore: '4/4',
          judgeScore: '5',
          type: 'weapon',
        },
      },
    }),
  );
}
