# Handoff: Emergency Repo Diagnosis — CI PR Disposition Scope Fix

**Date:** 2026-08-11  
**Branch:** `nalfeo-emergency-repo-diagnosis`  
**PR scope:** `.github/workflows/ci-pr-disposition.yml`, `tests/unit/ci-pr-disposition-workflow.test.ts`

## Systems touched

ci-recovery

## Problem

The `CI PR Disposition` workflow failed repeatedly before processing any open PRs. GitHub Actions reported `ReferenceError: ensureDispositionLabels is not defined`.

## Root Cause

Three GitHub Script steps accidentally declared `ensureDispositionLabels`, `ensureLabel`, `addLabelStrict`, and `removeLabelBestEffort` inside `upsertLifecycleComment`. The quarantine step also nested its trusted-lifecycle parsing helpers. The provisioning calls, lifecycle callbacks, and quarantine loop execute at script scope, so those helpers were out of scope.

## Fix

Closed each `upsertLifecycleComment` immediately after its comment upsert logic and moved the helper declarations to script scope. Added a source-level regression assertion that checks helper scope in every disposition GitHub Script block.

## Validation

The repaired GitHub Script blocks pass `node --check` when extracted into async wrappers. The targeted Vitest regression and repository verification pass locally.

## Next Steps

After publication, confirm the next `CI PR Disposition` run completes successfully and resumes normal PR disposition processing.
