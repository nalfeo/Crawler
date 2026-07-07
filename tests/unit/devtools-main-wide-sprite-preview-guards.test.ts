import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('devtools main wide sprite preview guards', () => {
  const source = readFileSync('src/devtools-main.ts', 'utf-8');

  it('keeps run candidate/detail previews at bounded size without forced square dimensions', () => {
    const makeImgElStart = source.indexOf(
      'const makeImgEl = (size: number): HTMLImageElement => {',
    );
    expect(makeImgElStart).toBeGreaterThan(-1);
    const makeImgElEnd = source.indexOf('\n    };', makeImgElStart);
    expect(makeImgElEnd).toBeGreaterThan(makeImgElStart);
    const makeImgElBody = source.slice(makeImgElStart, makeImgElEnd);

    expect(makeImgElBody).toContain('maxWidth: `${size}px`');
    expect(makeImgElBody).toContain('maxHeight: `${size}px`');
    expect(makeImgElBody).toContain("width: 'auto'");
    expect(makeImgElBody).toContain("height: 'auto'");
    expect(makeImgElBody).not.toContain('width: `${size}px`');
    expect(makeImgElBody).not.toContain('height: `${size}px`');
  });

  it('still uses makeImgEl for run-candidate and run-detail previews', () => {
    expect(source).toContain('const img = makeImgEl(96);');
    expect(source).toContain('const img = makeImgEl(128);');
  });
});
