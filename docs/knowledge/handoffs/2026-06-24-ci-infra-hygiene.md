# Handoff: CI / infra hygiene (PR Group E — Items 16 & 14)

**Date:** 2026-06-24
**Persona:** DevOps Engineer
**Routing verdict:** ✅ right persona — all work is `.github/workflows/**` + CODEOWNERS + verify scripts, squarely DevOps.

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎
- Verdict: 🎯 Exact — config-only deliverable, but spanned four sub-items across two
  workflows + CODEOWNERS and required real investigation (40-run e2e history,
  branch-protection wiring, GitHub permission model). Medium effort, no new module/tests.
- Hello kitties: 3/5 = 0.60 🎀

## What Was Done

### ITEM 16(a) — GitHub Actions caching

- **node_modules:** already cached in `.github/actions/setup-node/action.yml`
  (pre-existing `actions/cache` keyed on `package-lock.json`) — left as-is.
- **.eslintcache:** the blocking CI lint step ran `npm run lint` (no cache). Switched
  the `check-types-and-lint` job's lint step to `npm run lint:cache` (writes
  `.cache/eslint/.eslintcache`, same lint scope) and added an `actions/cache@v4` step
  for `.cache/eslint`. Key: `eslint-${os}-${hash(eslint.config.js, package-lock.json)}-${run_id}`
  with `restore-keys` fallbacks. The unique `run_id` suffix forces a fresh immutable
  cache each run; restore-keys warm-start from the latest prior cache. ESLint re-lints
  any file whose content changed, so a stale restore is always correct.

### ITEM 16(b) — e2e job now gates

- **Stability check first (as instructed):** sampled the last 40 CI runs across all
  branches via `gh run view --json jobs`; the `E2E visual regression tests` _step_
  conclusion was `success` in **40/40** runs — zero failures (the step conclusion is
  ground truth, not masked by `continue-on-error`). Stable → safe to gate.
- Removed `continue-on-error: true` from the `test-e2e` job.
- **Critical wiring:** branch protection requires the `ci` status check, and
  `ci` → `merge-gate` → `[types, format, unit, headless]` — which did **not** include
  `test-e2e`. So removing the flag alone would turn the run red but would **not** block
  merge. Added `test-e2e` to `merge-gate`'s `needs` and a `check "E2E Visual Regression"`
  line so the required `ci` check actually fails on e2e failure.

### ITEM 16(c) — CODEOWNERS persona routing matrix

- Appended a "Persona routing matrix" section to `CODEOWNERS` mirroring
  `docs/agent-os/personas/README.md` (Systems Engineer→`src/core/**`,
  UX→`src/engine/**`, Graphics→`src/engine/sprites/**`/`briefs/**`/`data/palettes/**`,
  Game Designer→`src/game/**`/`src/labs/**`/`tuning.json`, Content→`quests.*.json`,
  AI Content→`src/game/ai/**`, QA→`tests/**`, Story→`lore-bible.md`, DevOps→`.github/actions/**`).
- Single human owner repo, so every glob resolves to `@nalfeo`; the value is the
  explicit, machine-checkable path→persona mapping. Ordered general→specific
  (last-match-wins). Preserved the existing critical block required by
  `scripts/agent/security/check-codeowners.ts`. Gate passes (0 findings).

### ITEM 14 — manual-preview.yml admin blocker (analysis + fix)

**Determination: mixed — partly a fixable in-workflow over-restriction, partly a genuine
platform requirement. It is NOT a `permissions:` block issue.**

- The workflow's top-level `permissions:` block only scopes the `GITHUB_TOKEN` for the
  running job; it does **not** govern who may _trigger_ the workflow. Changing it would
  not help.
- The in-workflow `Admin check` step hard-required `admin` and was the over-restriction.
  **Fixed:** relaxed it to allow `admin` **or** `write` (the `.permission` field collapses
  maintain→write), so PR authors / maintainers with write access can now trigger it.
  Renamed the step to `Permission check` with clearer error messaging.
- **Genuine repo-settings requirement (documented, owner action):** the HTTP 403 the
  Copilot agent hit was on the `workflow_dispatch` API call itself — GitHub requires the
  triggering actor to have **≥ write** access to the repo to dispatch any workflow. A
  workflow file cannot grant that. If the agent/bot account that needs to trigger this
  has only read access, the repo owner must grant it **write** (or higher) on
  `nalfeo/Crawler` in repo settings → Collaborators/Teams. The relaxed guard now matches
  exactly what the platform already requires (write), so no one who _can_ dispatch is
  blocked by the workflow anymore.

## Files touched

- `.github/workflows/ci.yml` — eslintcache cache step + `lint:cache`; e2e gating (remove
  `continue-on-error`, add `test-e2e` to merge-gate `needs` + check line).
- `CODEOWNERS` — persona routing matrix section.
- `.github/workflows/manual-preview.yml` — admin check relaxed to write-or-higher.

## Verification

- `npm run verify:fast` → ✅ typecheck + lint clean (no source touched; no changed unit tests).
- `npm run lint:cache` → ✅ exit 0; `.cache/eslint/.eslintcache` produced (244 KB).
- `tsx scripts/agent/security/check-codeowners.ts` → ✅ 0 findings.
- `actionlint v1.7.12` on `ci.yml` + `manual-preview.yml` → ✅ exit 0 (validates `needs`
  references and all `${{ }}` expressions).
- `js-yaml` parse of both workflows → ✅ OK.

## Blockers

- None for the code changes. ITEM 14 residual: the repo owner must grant the triggering
  account ≥ write access for `workflow_dispatch` to succeed (platform rule; cannot be
  fixed in-repo).

## Recommended next steps

- After merge, if e2e ever flakes on CI infra variance, prefer adding a Playwright retry
  to the e2e step over restoring `continue-on-error`, to keep the gate.
- Optional: a deterministic doc-lint asserting CODEOWNERS persona globs stay in sync with
  the routing matrix (mentioned in the 2026-06-17 persona handoff's "What's Next").

## Branch State

- Branch: `nalfeo-ci-infra-hygiene`
- `npm run verify:fast`: ✅

## Agent-OS Telemetry

_No guard telemetry artifact (`files/guard-telemetry.jsonl`) was captured in this session._
