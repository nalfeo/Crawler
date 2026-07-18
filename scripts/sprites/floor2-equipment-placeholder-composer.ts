import { PNG } from 'pngjs';
import type {
  Floor2EquipmentArtDefinition,
  Floor2EquipmentFamily,
} from '../../src/shared/floor2-equipment-art.js';

interface Pixel {
  readonly x: number;
  readonly y: number;
}

const COMPONENTS: Readonly<Record<Floor2EquipmentFamily, readonly Pixel[]>> = {
  blade: line(4, 12, 11, 3, 2),
  axe: [...line(5, 13, 10, 4, 2), ...rect(8, 3, 4, 4)],
  bludgeon: [...line(6, 13, 9, 5, 2), ...rect(7, 3, 5, 4)],
  polearm: [...line(4, 13, 11, 2, 2), ...line(9, 4, 12, 1, 1)],
  bow: [...line(4, 3, 3, 11, 1), ...line(11, 3, 12, 11, 1), ...line(4, 3, 11, 11, 1)],
  firearm: [...rect(3, 6, 9, 3), ...rect(8, 9, 3, 3)],
  thrown: [...line(3, 11, 7, 4, 1), ...line(9, 11, 13, 4, 1)],
  'magic-focus': [...line(5, 13, 9, 5, 2), ...diamond(10, 4, 3)],
  beam: [...rect(3, 6, 6, 4), ...line(9, 7, 13, 7, 2)],
  trap: [...diamond(8, 8, 5), ...rect(6, 6, 5, 5)],
  headgear: [...rect(4, 6, 9, 6), ...line(5, 5, 11, 5, 1)],
  'body-armor': [...rect(4, 4, 9, 9), ...rect(2, 5, 2, 4), ...rect(13, 5, 2, 4)],
  handwear: [...rect(4, 5, 4, 7), ...rect(9, 5, 4, 7)],
  footwear: [...rect(4, 4, 3, 8), ...rect(9, 4, 3, 8), ...rect(3, 11, 5, 2), ...rect(8, 11, 5, 2)],
  accessory: [...diamond(8, 7, 4), ...line(8, 11, 8, 13, 1)],
};

function rect(x: number, y: number, width: number, height: number): Pixel[] {
  const pixels: Pixel[] = [];
  for (let py = y; py < y + height; py++) {
    for (let px = x; px < x + width; px++) {
      pixels.push({ x: px, y: py });
    }
  }
  return pixels;
}

function line(x0: number, y0: number, x1: number, y1: number, thickness: number): Pixel[] {
  const pixels: Pixel[] = [];
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  let x = x0;
  let y = y0;
  while (true) {
    pixels.push(...rect(x, y, thickness, thickness));
    if (x === x1 && y === y1) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
  return pixels;
}

function diamond(cx: number, cy: number, radius: number): Pixel[] {
  const pixels: Pixel[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (Math.abs(x - cx) + Math.abs(y - cy) <= radius) {
        pixels.push({ x, y });
      }
    }
  }
  return pixels;
}

function colorFor(ordinal: number): {
  readonly body: readonly [number, number, number];
  readonly highlight: readonly [number, number, number];
} {
  const channelA = 72 + ((ordinal * 47) % 128);
  const channelB = 72 + ((ordinal * 83) % 128);
  const channelC = 72 + ((ordinal * 109) % 128);
  return {
    body: [channelA, channelB, channelC],
    highlight: [
      Math.min(255, channelA + 48),
      Math.min(255, channelB + 48),
      Math.min(255, channelC + 48),
    ],
  };
}

function setPixel(png: PNG, x: number, y: number, color: readonly [number, number, number]): void {
  if (x < 0 || x >= png.width || y < 0 || y >= png.height) return;
  const offset = (y * png.width + x) * 4;
  png.data[offset] = color[0];
  png.data[offset + 1] = color[1];
  png.data[offset + 2] = color[2];
  png.data[offset + 3] = 255;
}

export function composeFloor2EquipmentPlaceholder(
  definition: Floor2EquipmentArtDefinition,
): Buffer {
  const png = new PNG({ width: 16, height: 16 });
  png.data.fill(0);
  const component = COMPONENTS[definition.compositionId];
  const filled = new Set(component.map(({ x, y }) => `${x},${y}`));
  const outline: Pixel[] = [];
  for (const { x, y } of component) {
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ] as const) {
      if (!filled.has(`${x + dx},${y + dy}`)) {
        outline.push({ x: x + dx, y: y + dy });
      }
    }
  }

  const outlineColor = [28, 28, 38] as const;
  const colors = colorFor(definition.ordinal);
  for (const pixel of outline) setPixel(png, pixel.x, pixel.y, outlineColor);
  for (const pixel of component) setPixel(png, pixel.x, pixel.y, colors.body);

  const highlighted = component.filter(({ x, y }) => x + y < 12).slice(0, 4);
  for (const pixel of highlighted) setPixel(png, pixel.x, pixel.y, colors.highlight);

  // Seven stable accent bits encode ordinals 1..70, ensuring each placeholder is
  // visually and byte-distinct while the reusable family silhouette stays clear.
  for (let bit = 0; bit < 7; bit++) {
    const enabled = (definition.ordinal & (1 << bit)) !== 0;
    setPixel(png, 1 + bit * 2, 14, enabled ? colors.highlight : outlineColor);
  }

  return PNG.sync.write(png, { colorType: 6, inputColorType: 6 });
}
