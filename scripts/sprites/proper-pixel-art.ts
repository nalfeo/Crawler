import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
}

const bridgePath = fileURLToPath(new URL('./proper-pixel-art-bridge.py', import.meta.url));
const RECOVERY_TIMEOUT_MS = 30_000;

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
 * The bridge returns the recovered native mesh without re-expanding it. The
 * pipeline's dedicated resize module remains the sole final-size authority.
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
      timeout: RECOVERY_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      windowsHide: true,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        PYTHONHASHSEED: '0',
        PYTHONNOUSERSITE: '1',
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONUTF8: '1',
      },
    });
  } catch (error) {
    const processError = error as Error & {
      readonly code?: string;
      readonly signal?: NodeJS.Signals;
      readonly stderr?: Buffer;
    };
    const detail = Buffer.isBuffer(processError.stderr)
      ? processError.stderr.toString('utf8').trim()
      : error instanceof Error
        ? error.message
        : String(error);
    if (processError.code === 'ETIMEDOUT' || processError.signal === 'SIGKILL') {
      throw new Error(
        `pixel-art recovery timed out after ${RECOVERY_TIMEOUT_MS}ms for ` +
          `${image.width}x${image.height} input`,
        { cause: error },
      );
    }
    if (processError.code === 'ENOBUFS') {
      throw new Error('pixel-art recovery output exceeded the 64 MiB process buffer', {
        cause: error,
      });
    }
    throw new Error(
      'pixel-art recovery failed. Install the pinned Python 3.12 dependencies ' +
        `from scripts/sprites/proper-pixel-art-requirements.txt.${detail ? ` ${detail}` : ''}`,
      { cause: error },
    );
  }

  if (output.length === 0) {
    throw new Error('pixel-art recovery failed: the upstream adapter produced no PNG output');
  }
  const recovered = decodePng(output);
  if (recovered.width === 1 && recovered.height === 1 && (image.width > 1 || image.height > 1)) {
    throw new Error(
      `pixel-art recovery failed to detect a non-trivial mesh for ` +
        `${image.width}x${image.height} input`,
    );
  }
  return recovered;
}
