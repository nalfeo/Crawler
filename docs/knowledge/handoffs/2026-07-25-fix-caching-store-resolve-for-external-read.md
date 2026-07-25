# Fix: CachingRunStore strips resolveForExternalRead — screenshots don't render in issue comments

**Date**: 2026-07-25  
**Session slug**: fix-caching-store-resolve-for-external-read  
**Apple estimate**: 🍎 (1 apple)  
**PR**: Closes #1948

## Systems touched

sprite-pipeline

## Summary

PR #1882 added image embeds to asset-request completion comments via `buildCompletionComment()`. The function calls `store.resolveForExternalRead()` to get SAS-signed URLs for private Azure blobs, falling back to `store.resolve()` (plain URL) when the method is absent.

In CI, the store is `AzureBlobRunStore` wrapped in `CachingRunStore` (because `CRAWLER_AZURE_CACHE` defaults to `'on'`). `CachingRunStore` only forwarded `resolve()` — it did **not** forward `resolveForExternalRead()`. As a result, `buildCompletionComment` always fell back to plain Azure blob URLs (no SAS token), which GitHub's Camo image proxy cannot fetch from the private `generated-runs` container → broken image embeds in issue comments.

Evidence: actual completion comment on issue #1313 contained `![Spritesheet](https://crawlersprites.blob.core.windows.net/generated-runs/.../sheet-00.png)` with **no SAS query string**.

## Fix

Added `resolveForExternalRead(key: string): string` to `CachingRunStore` that delegates to `this.inner.resolveForExternalRead(key)` when present, falling back to `this.inner.resolve(key)`.

**File changed**: `scripts/sprites/store/caching-store.ts` — 7 lines added alongside existing `resolve()`.

## Tests added

- `tests/unit/sprites/caching-run-store.test.ts`: two new assertions in the `backend / resolve` describe block — one for delegation and one for fallback.
- `tests/unit/sprites/issue-pipeline.test.ts`: one new regression test verifying `buildCompletionComment` uses SAS URLs when the store (like a `CachingRunStore`) exposes `resolveForExternalRead`.

## No design decisions or ADR needed

Trivial delegation fix; no new behavior or system interactions.
