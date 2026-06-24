# Handoff: Remove session guard CI policies

**Date:** 2026-06-23
**Apple estimate:** 🍎🍎
**Apple actual:** 🍎🍎
**Verdict:** On target

## Summary

Removed three CI workflows that were filing issues for merge conflicts and review comments but not producing useful results:

- `copilot-session-guard.yml` — commit-status lock on copilot branches
- `auto-rebase-prs.yml` — hourly rebase + merge-conflict issue filing
- `copilot-review-ping.yml` — issue filing for unresolved Copilot review comments

Also cleaned up the Session Lock section and Quick Start step 8 in `AGENTS.md`.

## Files touched

- `.github/workflows/copilot-session-guard.yml` (deleted)
- `.github/workflows/auto-rebase-prs.yml` (deleted)
- `.github/workflows/copilot-review-ping.yml` (deleted)
- `AGENTS.md` (removed Session Lock section + step 8)

## Verification

No code changes — only workflow YAML deletions and doc edits. No build/test impact.

## Unresolved issues

None.

## Recommended next steps

- Close any open issues with labels `merge-conflict` or `copilot-review-comments` that were filed by these workflows.
- If branch protection on `copilot/**` branches requires the `copilot/session-active` status check, remove that requirement from repo settings.
