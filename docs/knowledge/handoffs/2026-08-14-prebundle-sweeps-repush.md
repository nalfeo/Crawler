# 2026-08-14 — Re-publish prebundle-all-sweeps changes after merge-train truncation

## Summary

PR #2910 merged 10 hours prior to this handoff, but the merge train only
captured the branch's state at that time — which was the **narrow** first
checkpoint (`headless-bundle.mjs` wrapping only the single `ai:headless` CLI).
Later commits pushed to the same (already-merged) branch generalized the fix
to `prebundle-cli.mjs`, rewired `ai-sweep.yml` / `weapon-sweep.yml` /
`ai-sweep-recover.yml` to use it, and fixed worker/provenance edge cases —
none of that landed on `main`, since a merged PR does not retroactively pull
in later pushes to its branch.

This session merged `origin/main` (which had advanced ~40 commits with
unrelated floor/test work) into the branch, resolved conflicts in
`eslint.config.js`, `package.json`, `AGENTS.md`,
`.github/skills/perf-optimizer/references/measurement-recipes.md`,
`scripts/agent/perf/headless-bundle.mjs`, and
`tests/unit/agent/headless-bundle.test.ts` (all resolved by keeping the
already-more-general HEAD version), then re-validated and re-pushed so a new
PR can carry the sweep-workflow wiring to `main`.

## Files touched (this session's merge resolution)

- `eslint.config.js` — kept broader `.mjs` glob covering both singular and
  plural perf-script paths.
- `package.json` — kept `ai:hill-climb`/`ai:weapon-sweep`/`ai:winrate-sweep`
  routed through `prebundle-cli.mjs`.
- `AGENTS.md` — kept the fuller command table including the new prebundle row.
- `.github/skills/perf-optimizer/references/measurement-recipes.md` — kept
  the sweep-wide prebundle description.
- `scripts/agent/perf/headless-bundle.mjs` — kept as the thin compatibility
  wrapper delegating to `prebundle-cli.mjs`.
- `tests/unit/agent/headless-bundle.test.ts` — kept the version covering both
  the wrapper and `prebundle-cli.mjs` directly.

## Verification run

- `npm install` (worktree had no `node_modules`)
- `npm run verify:fast` — passed
- `npx vitest run tests/unit/agent/headless-bundle.test.ts tests/unit/ci-liveness-sweep-workflow.test.ts tests/unit/recover-checkpoint-validate.test.ts tests/unit/deploy-workflow-gating.test.ts --project unit` — 51 passed
- Confirmed post-merge `.github/workflows/{ai-sweep,weapon-sweep,ai-sweep-recover}.yml` all reference `node scripts/agent/perf/prebundle-cli.mjs --entry ...`
- `npm run verify:pr-prereqs` — ledger valid (`docs/knowledge/review-ledgers/2026-08-14-prebundle-all-sweeps.review-ledger.json`, 3-apple), blocked only on missing handoff (this file resolves that).

## Unresolved issues / next steps

- None functionally; this is a re-publish of already-reviewed work after a
  merge-train truncation artifact. Open a fresh PR from this branch state so
  the sweep-workflow wiring actually reaches `main`.
- Watch for the same truncation risk in the future: once a PR shows
  `MERGED`, further commits to that branch need a **new** PR — the merge
  train does not re-pick-up a branch after merging it.

## Systems touched

ai, tooling
