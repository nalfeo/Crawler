# Build Speed & Inner Loop Performance Optimization

**Session Date:** 2026-06-17  
**Agent:** AI Agent  
**Complexity:** 🍎🍎🍎 (Medium-High - multi-phase optimization with attempted structural changes)

## Summary

Implemented Phase 1 build performance optimizations achieving significant improvements in startup time and inner loop speed. The primary wins came from code splitting and ESLint caching. TypeScript project references were attempted but reverted due to complexity/benefit trade-off.

## Changes Made

### ✅ Completed

1. **Code Splitting & Lazy Loading** (vite.config.ts)
   - Split vendors into separate chunks: phaser (1.36MB), core (67KB), other (72KB)
   - Per-lab chunk splitting for lazy loading
   - Main bundle reduced from 1.7MB → 213KB
   - **Initial page load: 1.7MB → ~350KB (79% reduction)**

2. **ESLint Caching** (package.json, verify scripts)
   - Added `--cache --cache-location .eslintcache` to all lint commands
   - Updated .gitignore to exclude cache files
   - Subsequent lint runs now significantly faster

3. **Vite Build Optimizations** (vite.config.ts)
   - Enabled esbuild minification (faster than default)
   - Configured chunk size warnings at 600KB
   - Added optimizeDeps.include for key dependencies

4. **ESLint Configuration Fixes** (eslint.config.js)
   - Excluded generated .js and .d.ts files from linting
   - Prevented false errors on auto-generated code

### ⚠️ Attempted but Reverted

**TypeScript Project References**

- Created separate tsconfig files for each layer (shared, core, engine, game, labs, tests, scripts)
- Hit issues with cross-project imports (tests import from all layers, scripts import from src)
- Gained ~10% typecheck improvement but added significant config complexity
- **Decision:** Reverted to maintain simplicity; incremental compilation already working well

## Performance Results

### Before

- Full build: 4.0s
- TypeCheck: 2.8s
- Verify-fast: 25s
- Bundle: 1.7MB monolith

### After

- Full build: 3.7s (8% improvement)
- TypeCheck: 2.5s (11% improvement)
- Verify-fast: 18s (28% improvement ✅)
- Bundle: 213KB main + 1.36MB phaser (lazy) + vendors (79% reduction in initial load ✅)

## What Works Well

1. **Code splitting is highly effective** - Phaser is ~80% of the bundle, splitting it dramatically improves startup
2. **Labs already use dynamic imports** - import.meta.glob was already in place
3. **ESLint caching** - Simple change, immediate benefit for subsequent runs
4. **Incremental TypeScript** - Already enabled and working optimally

## Known Issues & Trade-offs

1. **TypeScript Project References** - Complex to maintain with current architecture. Tests and scripts legitimately import across layers. Would need architectural refactoring to make project references worthwhile.

2. **Vitest Workspaces** - Deferred. Current test execution is already fast (14s for 1,222 tests). Splitting would add complexity without major benefit.

3. **HMR Boundaries** - Deferred. Requires dev server testing. Most changes in this codebase trigger full reloads anyway due to ECS architecture.

## Recommendations for Future Work

### If pursuing further optimization:

1. **Asset Loading** - Consider lazy loading sprite atlases per floor (Phase 3)
2. **CI Caching** - Add GitHub Actions caching for node_modules and .eslintcache
3. **Bundle Analysis** - Use vite-bundle-visualizer to identify any other splitting opportunities

### If revisiting TypeScript Project References:

- Would need to refactor to prevent tests/scripts from importing across layer boundaries
- Consider creating test-specific exports or moving cross-cutting test utilities to shared/
- Cost/benefit likely still not worth it unless codebase grows 3-5x

## Files Changed

- vite.config.ts - Code splitting configuration
- package.json - ESLint caching in scripts
- scripts/agent/verify-fast.sh - ESLint caching
- scripts/agent/verify.sh - ESLint caching
- .gitignore - Cache files
- eslint.config.js - Exclude generated files

## Validation

- ✅ All 1,222 tests pass
- ✅ TypeScript compiles without errors
- ✅ ESLint passes (0 warnings)
- ✅ Build produces correct chunked output
- ✅ verify-fast completes successfully in 18s

## Metrics

**Apple Complexity:** 🍎🍎🍎

- Estimated: 🍎🍎 (thought it would be straightforward)
- Actual: 🍎🍎🍎 (TypeScript project references added complexity)
- Verdict: Medium-High. Code splitting was easy, TS project references were challenging and ultimately not viable.

**Time Spent:** ~2 hours

- Investigation & benchmarking: 30 min
- Phase 1 implementation: 30 min
- TypeScript project references attempt: 45 min
- Debugging & reverting: 15 min

## Context for Next Agent

The low-hanging fruit for build performance has been captured. The architecture is well-optimized for incremental builds (TypeScript incremental mode, ESLint caching, Vite's fast builds).

Major remaining opportunities require either:

1. Architectural changes (asset loading, HMR boundaries)
2. Infrastructure changes (CI caching)
3. Fundamental tool changes (unlikely to be beneficial with Vite 8 & TS 6)

The current 18s verify-fast is excellent for a 43k LOC codebase with 1,222 tests. Further optimization should focus on dev experience (HMR) rather than pure speed.
