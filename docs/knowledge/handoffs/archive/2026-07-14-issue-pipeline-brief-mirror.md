# Issue Pipeline Brief Mirror Fix

**Date:** 2026-07-14
**Session:** PR shepherd loop
**Apple estimate:** 1

## Summary

The issue->asset pipeline synthesizes a brief YAML, promotes it to disk, and calls
`runFull` to generate sprites. The brief was never uploaded to Azure blob storage,
so the local sidecar (which runs after the CI runner is gone) got a 404
`brief-not-found` error when trying to load it via `materializeBriefFromStore`.

Fixed by calling `mirrorBriefToStore` in `issue-pipeline.ts` immediately after
`enableJudge` mutates the promoted brief, so the final bytes are in Azure before
generation starts. The sidecar's existing `materializeBriefFromStore` path then
finds and restores it on demand.

## Root cause

`worker.ts` calls `mirrorBriefToStore` for `brief-path` queue jobs but
`runIssueRequest` delegates to `runIssuePipeline` which had no mirror call.

## Systems touched

sprite-pipeline

## Files touched

- `scripts/sprites/issue-pipeline.ts` — import + one `await mirrorBriefToStore` call

## Verification

`npx tsc --noEmit` clean. Existing sprite unit tests unaffected.

## Unresolved issues

Already-completed runs whose briefs were never mirrored cannot be recovered
without re-running synthesis. Those runs show the Synthesize button in the sidecar
workflow canvas to regenerate.

## Recommended next steps

None — the fix is self-contained.
