/* global console, process */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PNG } from 'pngjs';

const EDGE_DEPTH = 6;
const INTERIOR_INSET = 24;
const THRESHOLD = 0.1;

function usage() {
  console.error(
    'Usage: node scripts/agent/art/edge-frame-check.mjs <png-path> [--threshold 0.10] [--edge-depth 6] [--interior-inset 24]',
  );
}

function parseArgs(argv) {
  const options = {
    imagePath: '',
    threshold: THRESHOLD,
    edgeDepth: EDGE_DEPTH,
    interiorInset: INTERIOR_INSET,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      if (options.imagePath.length > 0) {
        throw new Error(`Unexpected positional argument: ${token}`);
      }
      options.imagePath = token;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`Missing value for ${token}`);
    }
    i++;
    switch (token) {
      case '--threshold':
        options.threshold = Number(value);
        break;
      case '--edge-depth':
        options.edgeDepth = Number(value);
        break;
      case '--interior-inset':
        options.interiorInset = Number(value);
        break;
      default:
        throw new Error(`Unknown option: ${token}`);
    }
  }

  if (!options.imagePath) throw new Error('Missing required <png-path>.');
  if (!Number.isFinite(options.threshold) || options.threshold < 0) {
    throw new Error('--threshold must be a finite number >= 0.');
  }
  if (!Number.isInteger(options.edgeDepth) || options.edgeDepth <= 0) {
    throw new Error('--edge-depth must be an integer > 0.');
  }
  if (!Number.isInteger(options.interiorInset) || options.interiorInset < 0) {
    throw new Error('--interior-inset must be an integer >= 0.');
  }

  return options;
}

function lumaAt(data, width, x, y) {
  const index = (y * width + x) << 2;
  const r = data[index];
  const g = data[index + 1];
  const b = data[index + 2];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function meanLumaRegion(png, minX, maxX, minY, maxY) {
  let total = 0;
  let count = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const index = (y * png.width + x) << 2;
      if (png.data[index + 3] === 0) continue;
      total += lumaAt(png.data, png.width, x, y);
      count++;
    }
  }
  if (count === 0) throw new Error('Selected region contains no opaque pixels.');
  return total / count;
}

function checkEdges(png, interiorLuma, edgeDepth, threshold) {
  const checks = [];
  for (let depth = 0; depth < edgeDepth; depth++) {
    const top = meanLumaRegion(png, 0, png.width - 1, depth, depth);
    const bottom = meanLumaRegion(
      png,
      0,
      png.width - 1,
      png.height - 1 - depth,
      png.height - 1 - depth,
    );
    const left = meanLumaRegion(png, depth, depth, 0, png.height - 1);
    const right = meanLumaRegion(
      png,
      png.width - 1 - depth,
      png.width - 1 - depth,
      0,
      png.height - 1,
    );

    checks.push(
      ['top', depth, top],
      ['bottom', depth, bottom],
      ['left', depth, left],
      ['right', depth, right],
    );
  }

  return checks.map(([side, depth, edgeLuma]) => {
    const relDelta = Math.abs(edgeLuma - interiorLuma) / interiorLuma;
    return {
      side,
      depth,
      edgeLuma,
      interiorLuma,
      relDelta,
      pass: relDelta < threshold,
    };
  });
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    usage();
    console.error(error.message);
    process.exit(2);
  }

  const png = PNG.sync.read(readFileSync(resolve(options.imagePath)));
  if (png.width <= options.interiorInset * 2 || png.height <= options.interiorInset * 2) {
    throw new Error(
      `Image ${png.width}x${png.height} is too small for interior inset ${options.interiorInset}.`,
    );
  }

  const interiorLuma = meanLumaRegion(
    png,
    options.interiorInset,
    png.width - 1 - options.interiorInset,
    options.interiorInset,
    png.height - 1 - options.interiorInset,
  );
  const results = checkEdges(png, interiorLuma, options.edgeDepth, options.threshold);
  const failing = results.filter((row) => !row.pass);

  console.log(
    JSON.stringify(
      {
        imagePath: options.imagePath,
        threshold: options.threshold,
        edgeDepth: options.edgeDepth,
        interiorInset: options.interiorInset,
        interiorLuma: Number(interiorLuma.toFixed(4)),
        checks: results.map((row) => ({
          ...row,
          edgeLuma: Number(row.edgeLuma.toFixed(4)),
          interiorLuma: Number(row.interiorLuma.toFixed(4)),
          relDelta: Number(row.relDelta.toFixed(6)),
        })),
        pass: failing.length === 0,
      },
      null,
      2,
    ),
  );

  process.exit(failing.length === 0 ? 0 : 1);
}

main();
