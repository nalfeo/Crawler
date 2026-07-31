# Handoff: PR #2365 test-only-exports guard recovery

**Date:** 2026-07-31  
**Session slug:** pr2365-test-only-exports-guard-recovery  
**Issue/PR:** nalfeo/Crawler#2365  
**Apple estimate:** 2🍎

## Systems touched

ci-policy

## What was done

- Investigated the latest PR #2365 CI failure using the GitHub Actions logs for run `30608580676`.
- Confirmed `Merge gate` was only failing because `Lightweight Checks` failed in `health-test-only-exports`.
- Narrowed `scripts/agent/health/test-only-exports.ts` so changed files contribute only branch-introduced exports as direct candidates.
- Preserved the existing deleted-import scan so unchanged exports whose last production caller was removed by the branch are still blocked.
- This prevents the guard from charging the inventory-lane PR for older test-only exports that already existed in files it merely edited.

## Files touched manually in this recovery

- `scripts/agent/health/test-only-exports.ts`
- `docs/knowledge/handoffs/2026-07-31-pr2365-test-only-exports-guard-recovery.md`

## Verification

- `github-mcp-server-actions_list(method=list_workflow_runs)` ✅
- `github-mcp-server-get_job_logs(job_id=91086223069)` ✅ identified `health-test-only-exports` as the root failure in `Lightweight Checks`
- `github-mcp-server-get_job_logs(job_id=91087885565)` ✅ confirmed `Merge gate` was downstream-only
- `git diff --check` ✅
- `npx tsx scripts/agent/health/test-only-exports.ts` ⚠️ blocked: missing repo dev dependencies in the sandbox
- `npm test -- --run tests/unit/agent/test-only-exports.test.ts` ⚠️ blocked: `vitest` unavailable before dependency install
- `npm install` ⚠️ blocked by `getaddrinfo ENOTFOUND ms-feed-12.pkgs.visualstudio.com`
- `runtime-tools-secret_scanning` on changed files ✅

## Notes

- Preflight's session-start sync attempted a rebase onto `origin/main` and aborted cleanly on conflict; the current PR state reported by GitHub for this recovery request was `mergeable_state=behind`, not `dirty`/conflicting.
- No `files/guard-telemetry.jsonl` artifact was present in this worktree.
