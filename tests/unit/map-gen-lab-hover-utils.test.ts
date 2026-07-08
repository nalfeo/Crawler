import { describe, expect, it } from 'vitest';
import {
  buildHoverTooltipContent,
  collectHoverTargetsAtPoint,
} from '../../src/labs/map-gen-lab/hover-utils.js';

describe('map-gen-lab hover utils', () => {
  it('collects all overlapping hover targets with topmost first', () => {
    const targets = [
      {
        kind: 'rect' as const,
        x: 0,
        y: 0,
        width: 20,
        height: 20,
        title: 'Bottom',
        lines: ['a'],
      },
      {
        kind: 'point' as const,
        x: 10,
        y: 10,
        radius: 8,
        title: 'Top',
        lines: ['b'],
      },
    ];
    const hits = collectHoverTargetsAtPoint(targets, 10, 10);
    expect(hits.map((entry) => entry.title)).toEqual(['Top', 'Bottom']);
  });

  it('builds overlap tooltip content that includes every hit target', () => {
    const content = buildHoverTooltipContent([
      { kind: 'point', x: 0, y: 0, radius: 5, title: 'Territory T1', lines: ['family=Rats'] },
      { kind: 'point', x: 0, y: 0, radius: 5, title: 'Boss den D1', lines: ['room=7'] },
    ]);
    expect(content.title).toBe('Overlapping regions (2)');
    expect(content.lines).toEqual(['• Territory T1', '  family=Rats', '• Boss den D1', '  room=7']);
  });
});
