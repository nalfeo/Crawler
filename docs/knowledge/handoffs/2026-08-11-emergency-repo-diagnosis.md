# Handoff: Emergency Repo Diagnosis — CI PR Disposition Scope Fix

**Date:** 2026-08-11  
**Branch:** `nalfeo-emergency-repo-diagnosis`  
**PR scope:** `.github/workflows/ci-pr-disposition.yml`, `tests/unit/ci-pr-disposition-workflow.test.ts`

## Systems touched

ci-recovery

## Problem

The `CI PR Disposition` workflow failed repeatedly before processing any open PRs. GitHub Actions reported `ReferenceError: ensureDispositionLabels is not defined`.

## Root Cause

The first GitHub Script step accidentally declared `ensureDispositionLabels`, `ensureLabel`, `addLabelStrict`, and `removeLabelBestEffort` inside `upsertLifecycleComment`. The provisioning call and lifecycle callbacks execute at script scope, so those helpers were out of scope.

## Fix

Closed `upsertLifecycleComment` immediately after its comment upsert logic and moved the helper declarations to script scope. Added a source-level regression assertion that preserves this ordering.

## Validation

The repaired GitHub Script block passes `node --check` when extracted into an async wrapper, and static helper-order assertions pass. Local Vitest and `verify-fast` could not run because this worktree has no installed dependencies and the configured package proxy returns 404 for `postcss@8.5.26`; a direct public-registry install is blocked by the environment's TLS handshake failure.

## Next Steps

After publication, confirm the next `CI PR Disposition` run completes successfully and resumes normal PR disposition processing.
