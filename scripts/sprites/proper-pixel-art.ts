import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const bridgePath = fileURLToPath(new URL('./proper-pixel-art-bridge.py', import.meta.url));

function pythonCommand(): { readonly command: string; readonly args: readonly string[] } {
  return process.platform === 'win32'
    ? { command: 'py', args: ['-3.12'] }
    : { command: 'python3.12', args: [] };
}

function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data = Buffer.from(image.data);
  return PNG.sync.write(png);
}

function decodePng(pngBuffer: Buffer): RgbaImage {
  const png = PNG.sync.read(pngBuffer);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

/**
 * Recover the source pixel mesh with the pinned proper-pixel-art Python package.
 *
 * No local grid heuristic is used: when the upstream detector cannot recover a
 * mesh, callers receive its failure instead of a silently destructive fallback.
 * The bridge returns the original canvas dimensions: recovery changes pixels,
 * while the pipeline's dedicated resize module owns canvas sizing.
 */
export function recoverPixelArtMesh(image: RgbaImage, pixelWidth?: number): RgbaImage {
  if (pixelWidth !== undefined && (!Number.isInteger(pixelWidth) || pixelWidth < 1)) {
    throw new Error('pixel-art recovery: pixelWidth must be a positive integer when provided');
  }

  const python = pythonCommand();
  const args = [...python.args, bridgePath, '--pixel-width', String(pixelWidth ?? 0)];
  let output: Buffer;
  try {
    output = execFileSync(python.command, args, {
      input: encodePng(image),
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
      windowsHide: true,
    });
  } catch (error) {
    const detail =
      error instanceof Error && 'stderr' in error && Buffer.isBuffer(error.stderr)
        ? error.stderr.toString('utf8').trim()
        : error instanceof Error
          ? error.message
          : String(error);
    throw new Error(
      `pixel-art recovery failed. Install Python 3.12 and ${'proper-pixel-art==1.7.2'} ` +
        `(see scripts/sprites/proper-pixel-art-requirements.txt).${detail ? ` ${detail}` : ''}`,
      { cause: error },
    );
  }

  if (output.length === 0) {
    throw new Error('pixel-art recovery failed: the upstream adapter produced no PNG output');
  }
  const recovered = decodePng(output);
  if (recovered.width !== image.width || recovered.height !== image.height) {
    throw new Error(
      `pixel-art recovery changed canvas size from ${image.width}x${image.height} ` +
        `to ${recovered.width}x${recovered.height}`,
    );
  }
  return recovered;
}
