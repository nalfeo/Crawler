import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The run-picker wiring lives inside the un-exportable `render()` IIFE in
// src/devtools-main.ts, so (per repo convention) we guard the behavior with
// source-string assertions. These lock in the plan-review concern resolutions
// for the Azure-run caching feature; the pure logic is unit-tested separately
// in devtools-sprite-run-cache.test.ts.
describe('devtools sprite run cache guards', () => {
  const source = readFileSync('src/devtools-main.ts', 'utf-8');

  it('imports the pure cache module', () => {
    expect(source).toContain("} from './devtools/sprite-run-cache.js';");
    expect(source).toContain('RUN_CACHE_STORAGE_KEY');
    expect(source).toContain('normalizePromotedFilter');
    expect(source).toContain('readRunCache');
    expect(source).toContain('writeRunCache');
    expect(source).toContain('resolveRunPickerSelection');
  });

  it('wraps localStorage access in try/catch so the UI works uncached', () => {
    expect(source).toContain(
      'return readRunCache(window.localStorage.getItem(RUN_CACHE_STORAGE_KEY), filter);',
    );
    expect(source).toContain(
      'writeRunCache(window.localStorage.getItem(RUN_CACHE_STORAGE_KEY), filter, runs),',
    );
  });

  it('hydrates both run pickers from cache before revalidating', () => {
    // Azure picker + debugger picker both have a cache-hydrate helper...
    expect(source).toContain('const hydrateAzureRunsFromCache = (): void => {');
    expect(source).toContain('const hydrateDebuggerRunsFromCache = (): void => {');
    // ...and both are invoked at boot before the slow network refresh.
    expect(source).toContain('hydrateAzureRunsFromCache();');
    expect(source).toContain('hydrateDebuggerRunsFromCache();');
    expect(source).toContain('void refreshDebuggerRuns({ background: true });');
  });

  it('persists the run list only on a successful fetch (never on failure)', () => {
    expect(source).toContain('writeCachedRuns(filter, runs);');
    expect(source).toContain("writeCachedRuns('all', runs);");
  });

  it('concern #1: a background debugger refresh preserves the operator selection', () => {
    // previousKey is captured up-front and restored with priority over debugTarget.
    expect(source).toContain('const previousKey = debuggerRunSelect.value;');
    expect(source).toContain('const restoreKey = resolveRunPickerSelection(');
    expect(source).toContain('debugTargetKey,');
    // Quiet (background + cached) refresh must not disable the buttons.
    expect(source).toContain('const quiet = background && debuggerRuns.length > 0;');
  });

  it('concern #2: the debugger Load handler resolves variants before pinning', () => {
    // Handler is async and awaits real variant indices when the cache is cold.
    expect(source).toContain('if (!debuggerVariantCache.has(runKey)) {');
    expect(source).toContain('await loadDebuggerVariantOptions();');
  });

  it('concern #3: loading a run invalidates any in-flight refresh', () => {
    expect(source).toContain('++azureRefreshToken;');
  });

  it('concern #4: switching filters paints the cached slot before revalidating', () => {
    expect(source).toContain('const cached = readCachedRuns(filter);');
    // A never-cached filter shows a loading placeholder, not the previous list.
    expect(source).toContain("opt.textContent = 'Loading runs…';");
  });

  it('concern #5: a 404 on load reconciles the stale (deleted) run silently', () => {
    expect(source).toContain('if (err instanceof Error && /\\b404\\b/.test(err.message)) {');
    expect(source).toContain('void refreshAzureRuns({ silent: true });');
  });

  it('surfaces a "showing cached runs" status while revalidating', () => {
    expect(source).toContain("reloadStatus.textContent = 'Showing cached runs — refreshing…';");
    expect(source).toContain('Showing cached runs (${cached.length}) — refreshing…');
  });

  it('concern #2/#3: hydrate paints a cached empty list ([]) rather than dropping it', () => {
    // The buggy guard early-returned for BOTH null (never cached) and [] (known
    // empty), leaving a blank dropdown even when the cache said "no runs". That
    // combined guard must be gone from both hydrate helpers.
    expect(source).not.toContain('if (!cached || cached.length === 0) {');

    const sliceFn = (marker: string): string => {
      const start = source.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const end = source.indexOf('\n  };', start);
      expect(end).toBeGreaterThan(start);
      return source.slice(start, end);
    };

    // Both hydrate helpers now bail only on a null (never-cached) slot, so a
    // cached [] falls through to render the known-empty state.
    const azure = sliceFn('const hydrateAzureRunsFromCache = (): void => {');
    expect(azure).toContain('if (!cached) {');
    expect(azure).not.toContain('cached.length === 0) {');
    // ...and the empty case gets its own status text.
    expect(azure).toContain('(none found)');

    const dbg = sliceFn('const hydrateDebuggerRunsFromCache = (): void => {');
    expect(dbg).toContain('if (!cached) {');
    expect(dbg).not.toContain('cached.length === 0) {');
  });
});
