# 2026-07-21 — Fix GITHUB_SHA propagation in ai-sweep-recover.yml

## Systems touched

ai-combat-balance, ci-policy

## Summary

Recovery run 29869238382 (PR #1760's `.github/workflows/ai-sweep-recover.yml`)
failed at the "Validate navmesh+slackAware" step with:

```
Search artifact workflow-sha '18929bed51edb1979db2650e3329cf4fe63ff418' != current '4914bd8ebcb449767d29707273d74b5a4e9e2784'
```

even though the step declared a step-level `env: GITHUB_SHA:
${{ needs.recover-preflight.outputs.head_sha }}` override intended to make
`sweep-eval.ts`'s `currentBuildFingerprint()` (which reads
`process.env.GITHUB_SHA`) see the historical SHA instead of the dispatch SHA.

**Root cause (confirmed via GitHub's own docs, not npx/npm behavior):**
GitHub Actions **silently discards** any `env:` override (workflow, job, or
step level) of the default `GITHUB_*`/`RUNNER_*` variables. Per
<https://docs.github.com/en/actions/reference/workflows-and-actions/variables#default-environment-variables>:

> You can't overwrite the value of the default environment variables named
> `GITHUB_*` and `RUNNER_*`.

The YAML's logged/displayed `GITHUB_SHA` value in the run log was cosmetic —
the actual `npx tsx` child process still saw the real (dispatch) `GITHUB_SHA`,
exactly reproducing the reported symptom. Confirmed empirically via
`gh run view --job 88765134863 --log` for the failed job.

Preflight for this same run (source run 29786216369, round-2 checkpoints)
succeeded completely, proving the checkpoints themselves are valid and the
bug is purely in SHA propagation during validate/aggregate.

## Fix

Since `GITHUB_SHA` can never be set via `env:`, thread the historical SHA
through a differently-named, non-reserved env var (`RECOVER_HEAD_SHA`), then
perform the actual override **inline at the shell exec boundary**,
immediately before spawning each child process:

```yaml
env:
  RECOVER_HEAD_SHA: ${{ needs.recover-preflight.outputs.head_sha }}
run: |
  GITHUB_SHA="$RECOVER_HEAD_SHA" npx tsx scripts/agent/perf/sweep-eval.ts ...
```

This is ordinary shell "temporary env var for one command" syntax, executed
by the already-running step's own shell process — not a runner-level env
injection — so it is not subject to GitHub's reserved-variable restriction
and reliably reaches the `npx tsx` child.

Applied to all three affected `npx tsx` invocations:

- `recover-validate` job → `sweep-eval.ts` ("Validate finalist + incumbent" step)
- `recover-aggregate` job → `gen-configs.ts` and `aggregate-shards.ts` ("Build leaderboard" step)

`ai-sweep.yml` and all sweep/aggregation logic (`sweep-eval.ts`,
`aggregate-shards.ts`) were **not modified** — this is a pure workflow-YAML +
test fix.

## Files changed

- `.github/workflows/ai-sweep-recover.yml` — reworded the "WHY SHA-PINNING"
  header comment to correctly document the exec-boundary mechanism and cite
  the GH reserved-variable restriction; renamed `env.GITHUB_SHA` →
  `env.RECOVER_HEAD_SHA` in both affected steps; added inline
  `GITHUB_SHA="$RECOVER_HEAD_SHA"` prefixes to the three `npx tsx`
  invocations.
- `scripts/agent/perf/recover-checkpoint-validate.ts` — updated the top doc
  comment describing the (unchanged) `expectedWorkflowSha` parameter
  rationale to reflect the corrected propagation mechanism. No functional
  change — this is a pure validator function unaffected by the propagation
  bug.
- `tests/unit/recover-checkpoint-validate.test.ts`:
  - Fixed the stale structural test that asserted the old (never-functional)
    `env.GITHUB_SHA` key.
  - Added a negative structural assertion: no step in `recover-validate` or
    `recover-aggregate` sets `GITHUB_SHA` via `env:` (guards against
    regressing back to the broken pattern).
  - Added structural coverage for the `recover-aggregate` exec-boundary
    pattern (previously untested).
  - **Added a deterministic EXECUTION-level regression** that extracts the
    real inline `GITHUB_SHA="$RECOVER_HEAD_SHA"` idiom from the parsed YAML
    (not a hand-duplicated copy) and executes it for real via
    `spawnSync('bash', ...)`, spawning a `printenv` child with a conflicting
    ambient `GITHUB_SHA` (simulating the runner's dispatch SHA) plus the
    resolved override — asserting the child actually receives the historical
    SHA. This proves runtime propagation, not merely YAML env-key presence
    (the previous test's blind spot that let the bug ship). Gated on
    `hasBash` per the repo's WSL-bash-on-Windows pattern
    (`tests/helpers/bash-script-path.ts`'s `bashEnv()`); uses `printenv`
    rather than `node` for the probe binary since a plain `bash` on
    `PATH` on Windows may resolve to the WSL interop shim, which has its own
    separate toolchain/PATH that may not include `node`.

## Verification

- `npx vitest run tests/unit/recover-checkpoint-validate.test.ts` — 36/36 passed,
  including the new execution-level regression (confirmed it fails without
  the fix, passes with it, by construction of the ambient-vs-override
  conflict).
- `npm run verify:fast` — passed (typecheck, lint, changed tests, physics/size/weight
  coverage checks all green).
- `npm run verify:pr-prereqs` — passed after this handoff + review ledger were added.

## Secondary fix (pushed by CI-recovery automation during this PR's own CI run)

While this PR's CI was running, `tests/unit/verify-fast-typecheck.test.ts`'s
signal-lifecycle test hit a pre-existing, unrelated flake on a loaded runner:
`cleanup_parallel()` in `scripts/agent/verify-fast.sh` sent only `SIGTERM` in
its `EXIT` trap and returned immediately, so the test's single `kill -0`
liveness check could run before the OS finished reaping the killed
descendants. The repo's CI-recovery automation dispatched `@copilot`, and
`copilot-swe-agent` pushed commit `f7c715e8` with a narrowly-scoped fix:
`cleanup_parallel()` now follows `SIGTERM` with `SIGKILL`, and the test polls
up to 1s (20 × 50ms) for descendant reaping instead of checking once. This is
unrelated to the AI-sweep SHA-propagation fix but is disclosed here (and in
the PR description) per the repo's holistic-PR-description policy, after a
`copilot-pull-request-reviewer` finding flagged it as undisclosed scope.

## Apple estimate

**2🍎** — narrow single-workflow-file + single-test-file fix, matching the
precedent scope in `docs/knowledge/handoffs/2026-07-21-ai-sweep-recover-checkpoint-r2.md`.
No review-harness stages required at this tier (ledger only). The secondary
flaky-test fix above is a small, independently-scoped addition that doesn't
change the tier.

## Unresolved issues / follow-ups

None. `ai-sweep.yml` and sweep/aggregation logic are unchanged by design.

## Rerun instructions (for whoever owns the recovery — NOT dispatched by this session)

Once this PR merges to `main`, rerun the recovery workflow against the fixed
`main`:

```
gh workflow run ai-sweep-recover.yml --ref main -f source_run_id=29786216369 -f train_seeds=1-80 -f validate_seeds=1-100 -f weapons=sword,bow,baseball-bat -f workers=4
```
