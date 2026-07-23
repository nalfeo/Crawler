import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { PNG } from 'pngjs';
import type { GenerateSheetRequest } from '../../../scripts/sprites/provider/types';
import { LocalA1111ImageProvider } from '../../../scripts/sprites/provider/local-a1111';
import { ProviderError } from '../../../scripts/sprites/provider/types';
import { sliceSheetFromBrief } from '../../../scripts/sprites/slice-sheet';

describe('LocalA1111ImageProvider', () => {
  let provider: LocalA1111ImageProvider;
  let mockFetch: Mock<typeof fetch>;

  beforeEach(() => {
    mockFetch = vi.fn<typeof fetch>();
  });

  function makeRequest(overrides: Partial<GenerateSheetRequest> = {}): GenerateSheetRequest {
    return {
      brief: {
        type: 'item',
        variations: [],
        generation: {
          sheet: {
            rows: 2,
            cols: 2,
            emptyCells: [],
            nativeCanvas: 256,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      prompt: 'sheet prompt (unused by local-a1111)',
      singleVariantPrompt: 'single variant prompt',
      referencePngs: [],
      variants: 4,
      ...overrides,
    };
  }

  it('generates a sheet with N variants stitched into a grid', async () => {
    // Create a minimal mock A1111 response: 4 images in base64.
    const createMockImage = (color: number): string => {
      const png = new PNG({ width: 112, height: 112 });
      // Fill with a solid color (R, G, B, A).
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = color; // R
        png.data[i + 1] = 0; // G
        png.data[i + 2] = 0; // B
        png.data[i + 3] = 255; // A (opaque)
      }
      return PNG.sync.write(png).toString('base64');
    };

    // Mock A1111 responses. In real A1111, each txt2img call returns
    // one image in the response. We'll simulate that here.
    let callCount = 0;
    mockFetch.mockImplementation(async () => {
      const images = await Promise.all([
        createMockImage(255), // Red
        createMockImage(200), // Less red
        createMockImage(100), // Even less
        createMockImage(50), // Very faint
      ]);
      const img = images[callCount % 4];
      callCount++;
      return {
        ok: true,
        json: async () => ({ images: [img] }),
      } as Response;
    });

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    // Create a mock brief with a 2x2 grid (4 variants).
    const request = makeRequest();

    const sheetBuffer = await provider.generateSheet(request);

    // Verify the sheet is a valid PNG.
    expect(() => PNG.sync.read(sheetBuffer)).not.toThrow();

    // Verify the sheet size is 256x256.
    const sheet = PNG.sync.read(sheetBuffer);
    expect(sheet.width).toBe(256);
    expect(sheet.height).toBe(256);

    // Verify 4 fetch calls were made (one per variant).
    expect(mockFetch).toHaveBeenCalledTimes(4);

    // Verify each call was a POST to txt2img with the right shape.
    for (let i = 0; i < 4; i++) {
      const call = mockFetch.mock.calls[i]!;
      const init = call[1] as RequestInit;
      expect(call[0]).toBe('http://localhost:7860/sdapi/v1/txt2img');
      expect(init.method).toBe('POST');
      const body = JSON.parse(init.body as string);
      expect(body.prompt).toContain('single variant prompt');
      expect(body.width).toBe(112); // 256/2 slot, rounded down to a multiple of 8.
      expect(body.height).toBe(112);
      expect(body.override_settings.sd_model_checkpoint).toBe('sd_xl_turbo');
    }
  });

  it('handles network errors gracefully', async () => {
    mockFetch.mockRejectedValue(new Error('Connection refused'));

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
      timeoutMs: 1000,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 1, cols: 1, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 1,
    });

    await expect(provider.generateSheet(request)).rejects.toThrow(ProviderError);
  });

  it('handles non-OK HTTP responses with appropriate error kinds', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => 'Service unavailable',
    } as Response);

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 1, cols: 1, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 1,
    });

    let error: ProviderError | null = null;
    try {
      await provider.generateSheet(request);
    } catch (e) {
      error = e as ProviderError;
    }

    expect(error).not.toBeNull();
    expect(error!.kind).toBe('server-error');
    expect(error!.message).toContain('503');
  });

  it('validates PNG responses', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        images: ['not-valid-base64-or-png'],
      }),
    } as Response);

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 1, cols: 1, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 1,
    });

    let error: ProviderError | null = null;
    try {
      await provider.generateSheet(request);
    } catch (e) {
      error = e as ProviderError;
    }

    expect(error).not.toBeNull();
    expect(error!.kind).toBe('non-png');
  });

  it('respects seed when provided', async () => {
    mockFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const png = new PNG({ width: body.width, height: body.height });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i + 3] = 255;
      }
      const chunks: Buffer[] = [];
      return new Promise<Response>((resolve) => {
        png
          .pack()
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .on('end', () => {
            resolve({
              ok: true,
              json: async () => ({ images: [Buffer.concat(chunks).toString('base64')] }),
            } as Response);
          });
      });
    });

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
      seed: 42,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 1, cols: 2, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 2,
    });

    await provider.generateSheet(request);

    // Verify that seeds were incremented: 42, 43.
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const call0 = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string);
    const call1 = JSON.parse((mockFetch.mock.calls[1]![1] as RequestInit).body as string);

    expect(call0.seed).toBe(42);
    expect(call1.seed).toBe(43);
  });

  it('fills empty cells with the magenta sheet background', async () => {
    mockFetch.mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      const png = new PNG({ width: body.width, height: body.height });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 255; // Red
        png.data[i + 3] = 255; // Opaque
      }
      const chunks: Buffer[] = [];
      return new Promise<Response>((resolve) => {
        png
          .pack()
          .on('data', (chunk: Buffer) => chunks.push(chunk))
          .on('end', () => {
            resolve({
              ok: true,
              json: async () => ({ images: [Buffer.concat(chunks).toString('base64')] }),
            } as Response);
          });
      });
    });

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: {
          sheet: {
            rows: 2,
            cols: 2,
            emptyCells: [[1, 1]], // Mark bottom-right as empty
            nativeCanvas: 256,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const sheetBuffer = await provider.generateSheet(request);
    const sheet = PNG.sync.read(sheetBuffer);

    // Verify only 3 fetches (not 4, because [1,1] is empty).
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // The empty cell at [1,1] should keep the magenta sheet background.
    const emptyX = 191;
    const emptyY = 191;
    const emptyIdx = (emptyY * 256 + emptyX) * 4;
    expect(sheet.data[emptyIdx]).toBe(255); // R
    expect(sheet.data[emptyIdx + 1]).toBe(0); // G
    expect(sheet.data[emptyIdx + 2]).toBe(255); // B
    expect(sheet.data[emptyIdx + 3]).toBe(255); // A

    // A non-empty cell should be opaque.
    const filledIdx = (10 * 256 + 10) * 4 + 3; // Inside the first rendered cell, alpha channel
    expect(sheet.data[filledIdx]).toBe(255); // Fully opaque
  });

  it('fully populates the grid when the empty cell is not in a trailing position', async () => {
    // Regression: with a non-trailing empty cell the orchestrator passes
    // `variants` = variantCount(brief) = rows*cols - emptyCells (3 here). The old
    // loop iterated `variants` directly and stopped early, leaving the final cell
    // (1,1) as un-generated magenta background. Iterating every grid cell fixes
    // it: 3 content cells are generated and only (0,0) is a placeholder.
    const createGreenImage = (): string => {
      const png = new PNG({ width: 112, height: 112 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = 0; // R
        png.data[i + 1] = 255; // G
        png.data[i + 2] = 0; // B
        png.data[i + 3] = 255; // A (opaque)
      }
      return PNG.sync.write(png).toString('base64');
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ images: [createGreenImage()] }),
    } as Response);

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: {
          sheet: {
            rows: 2,
            cols: 2,
            emptyCells: [[0, 0]], // leading empty cell (non-trailing)
            nativeCanvas: 256,
          },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 3, // variantCount(brief) — the value the orchestrator actually passes
    });

    const sheetBuffer = await provider.generateSheet(request);
    const sheet = PNG.sync.read(sheetBuffer);

    // All 3 content cells generated (the old loop fetched only 2).
    expect(mockFetch).toHaveBeenCalledTimes(3);

    // The leading empty cell (0,0) keeps the magenta sheet background.
    const emptyIdx = (64 * 256 + 64) * 4;
    expect(sheet.data[emptyIdx]).toBe(255); // R
    expect(sheet.data[emptyIdx + 1]).toBe(0); // G
    expect(sheet.data[emptyIdx + 2]).toBe(255); // B

    // The trailing cell (1,1) must contain generated GREEN content, not the
    // leftover magenta background — this is the exact pixel the old loop skipped.
    const filledIdx = (192 * 256 + 192) * 4;
    expect(sheet.data[filledIdx]).toBe(0); // R
    expect(sheet.data[filledIdx + 1]).toBe(255); // G
    expect(sheet.data[filledIdx + 2]).toBe(0); // B
    expect(sheet.data[filledIdx + 3]).toBe(255); // A
  });

  it('rejects an image whose dimensions do not match the requested cell (bad-grid)', async () => {
    // Regression: a backend that ignores the requested width/height and returns a
    // larger image used to overwrite the gutter and bleed into the adjacent slot,
    // collapsing multiple cells into one when the sheet was later sliced. The
    // provider now fails fast with a `bad-grid` error instead of stitching a
    // corrupt grid.
    const oversized = (): string => {
      const png = new PNG({ width: 256, height: 256 }); // requested cell is 112x112
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i + 3] = 255;
      }
      return PNG.sync.write(png).toString('base64');
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ images: [oversized()] }),
    } as Response);

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 2, cols: 2, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 4,
    });

    await expect(provider.generateSheet(request)).rejects.toMatchObject({
      kind: 'bad-grid',
    });
  });

  it('rejects unsupported brief types', async () => {
    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      brief: {
        type: 'character',
        variations: [],
        generation: { sheet: { rows: 1, cols: 1, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      variants: 1,
    });

    await expect(provider.generateSheet(request)).rejects.toMatchObject({
      kind: 'request-error',
    });
  });

  it('rejects requests without a single-variant prompt', async () => {
    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest({
      singleVariantPrompt: undefined,
      variants: 1,
      brief: {
        type: 'item',
        variations: [],
        generation: { sheet: { rows: 1, cols: 1, emptyCells: [], nativeCanvas: 256 } },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    await expect(provider.generateSheet(request)).rejects.toMatchObject({
      kind: 'request-error',
    });
  });

  it('produces sheets the brief slicer can recover at exact variant count', async () => {
    const createOpaqueImage = (rgba: readonly [number, number, number, number]): string => {
      const png = new PNG({ width: 112, height: 112 });
      for (let i = 0; i < png.data.length; i += 4) {
        png.data[i] = rgba[0];
        png.data[i + 1] = rgba[1];
        png.data[i + 2] = rgba[2];
        png.data[i + 3] = rgba[3];
      }
      return PNG.sync.write(png).toString('base64');
    };

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [createOpaqueImage([255, 0, 0, 255])] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [createOpaqueImage([0, 255, 0, 255])] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [createOpaqueImage([0, 0, 255, 255])] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [createOpaqueImage([255, 255, 0, 255])] }),
      } as Response);

    provider = new LocalA1111ImageProvider({
      endpoint: 'http://localhost:7860',
      model: 'sd_xl_turbo',
      fetch: mockFetch,
    });

    const request = makeRequest();
    const sheet = await provider.generateSheet(request);
    const { cells } = sliceSheetFromBrief(sheet, request.brief);
    expect(cells).toHaveLength(4);
  });
});
