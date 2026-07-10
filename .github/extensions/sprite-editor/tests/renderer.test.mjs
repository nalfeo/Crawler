import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderHtml } from '../renderer.mjs';

test('sprite editor wires OpenCV scaling controls and methods', () => {
  const html = renderHtml('x');
  assert.match(html, /Apply OpenCV scale/);
  assert.match(html, /https:\/\/docs\.opencv\.org\/4\.10\.0\/opencv\.js/);
  assert.match(html, /SCALE_FACTOR_MIN = 0\.25/);
  assert.match(html, /SCALE_FACTOR_MAX = 8/);
  assert.match(html, /Nearest \(pixel-perfect\)/);
  assert.match(html, /Bilinear/);
  assert.match(html, /Bicubic/);
  assert.match(html, /Pixel-area \(best downscale\)/);
  assert.match(html, /Lanczos4/);
  assert.match(html, /function resolveInterpolation\(cv, methodId, factor\)/);
  assert.match(html, /if \(id === 'area'\) return factor < 1 \? cv\.INTER_AREA/);
  assert.match(html, /cv\.resize\(src, dst, dsize, 0, 0, interpolation\)/);
});
