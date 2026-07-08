/**
 * Node-only helper: read the REAL recast `.wasm` binary off disk.
 *
 * WHY THIS IS A SEPARATE FILE
 * ---------------------------
 * It touches `node:module` + `node:fs`, which do not exist in a browser bundle.
 * `navmesh-pather.ts` imports it ONLY via a guarded, `@vite-ignore`d dynamic
 * import inside its Node branch, so Vite never pulls these node builtins into the
 * lab/game browser graph. In the browser, recast's Emscripten glue fetches the
 * `.wasm` asset itself (Vite resolves the `new URL(...)` asset), so this file is
 * never loaded there.
 *
 * WHY WE READ THE BYTES OURSELVES (the #1 determinism footgun)
 * -----------------------------------------------------------
 * The default `@recast-navigation/wasm` export is the asm.js "compat" build
 * (pure-JS float64 in the host engine) — a DIFFERENT float profile than the real
 * `.wasm` build, which would invalidate the cross-platform determinism proof. We
 * force `@recast-navigation/wasm/wasm` (the single-file, single-threaded,
 * non-SIMD real WASM module). Under Node its Emscripten glue is browser-shaped
 * and tries to `fetch()` the `.wasm` URL (which fails), so we read the sibling
 * `.wasm` bytes here and hand them to the factory as `wasmBinary` — Emscripten
 * then skips all fetch/streaming paths.
 */

/**
 * Resolve and read the real `recast-navigation.wasm.wasm` binary from the
 * installed `@recast-navigation/wasm/wasm` package (the `.wasm.js` glue's
 * sibling). Returns the raw bytes to inject as Emscripten's `wasmBinary`.
 */
export async function readRecastWasmBinary(): Promise<Uint8Array> {
  const { createRequire } = await import('node:module');
  const { readFileSync } = await import('node:fs');
  const require = createRequire(import.meta.url);
  // Resolves to `.../dist/recast-navigation.wasm.js`; the sibling binary is the
  // same path with `.js` → `.wasm` (see @recast-navigation/wasm package.json
  // "files": recast-navigation.wasm.js + recast-navigation.wasm.wasm).
  const wasmJsPath = require.resolve('@recast-navigation/wasm/wasm');
  const wasmBinaryPath = wasmJsPath.replace(/\.js$/, '.wasm');
  return readFileSync(wasmBinaryPath);
}
