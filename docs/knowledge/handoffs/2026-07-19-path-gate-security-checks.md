# Session Handoff: Path-gate security checks and deduplicate npm audit

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci

## Apples

2🍎 exact — GitHub Actions YAML changes plus shared classifier extension and tests.

## What Was Done

Added three orthogonal security-impact flags to the shared change classifier
(`scripts/agent/ci/detect-art-only.sh`) and used them in `security-review.yml`
to skip individual security checks when their relevant surfaces are unchanged.
Removed the duplicate `npm audit` from `ci.yml`'s advisory job.

### New classifier flags

| Flag                   | `true` when…                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencies_touched` | `package.json`, `package-lock.json`, `yarn.lock`, `npm-shrinkwrap.json`, or `scripts/agent/security/check-deps.ts` changed              |
| `ai_code_touched`      | `src/game/ai/**`, `scripts/agent/security/check-ai-prompts.ts`, `.github/copilot-instructions.md`, or `.github/instructions/**` changed |
| `codeowners_touched`   | `CODEOWNERS`, `.github/workflows/**`, or `scripts/agent/security/check-codeowners.ts` changed                                           |

All three flags default to `false` (fail-safe → `emit_all` passes them through;
the security-review.yml normalize step forces them to `true` for non-PR events so
scheduled runs always execute the full suite).

### security-review.yml changes

- `changes` job now exposes `art_only`, `dependencies_touched`, `ai_code_touched`,
  `codeowners_touched` as outputs (in addition to existing `docs_only`, `train_promoted`).
- Normalize step (`Normalize scope for security review`) forces all new flags to
  `'true'` for scheduled and `workflow_dispatch` events.
- `security-checks` job:
  - `setup-node` skipped for docs/asset-only PRs (only secret scan needs git, not Node).
  - Secret scan split: docs-only path runs `bash scan-secrets.sh` directly (no Node);
    non-docs path wraps with `wrap-step.ts` for structured scheduled reporting.
  - `npm audit` + `Dependency allowlist` gated on `dependencies_touched != 'false'`.
  - `CODEOWNERS coverage` gated on `codeowners_touched != 'false'`.
  - `Dynamic-execution patterns` additionally skips when `art_only == 'true'`.
  - `AI prompt-injection scan` gated on `ai_code_touched != 'false'`.
  - Fail-safe pattern: all gates use `!= 'false'` so an absent/empty flag runs the check.

### ci.yml changes

Removed the duplicate `Security audit` (`npm audit --audit-level=high`) step from
the `ci-advisory` job. The `security-review.yml` workflow is now the single
authoritative path for npm audit on PRs.

### Tests

- `tests/unit/detect-change-scope.test.ts`: extended `Scope` interface, `run()`,
  and `F()` to include the three new flags; added 12 new table-driven test cases;
  updated 5 existing cases where `codeowners_touched` or `dependencies_touched`
  is non-default (`package.json` → `dependencies_touched=true`; workflow changes
  → `codeowners_touched=true`).
- `tests/unit/merge-train-promotion-gate.test.ts`: updated `runSecurityScope()` to
  pass new template expressions for the renamed step and new detect outputs.

## Key Decisions

- **Fail-safe via `!= 'false'`**: security check conditions use `!= 'false'` rather
  than `== 'true'`, so an unset/empty output from a classifier failure runs the check.
- **No second taxonomy**: new flags live in the shared `detect-art-only.sh` classifier,
  consistent with the approach from issue #1688 (rather than a security-specific script).
- **Bash `case *` crosses slashes**: the `src/game/ai/*` pattern in bash case statements
  matches all files in subdirectories (bash glob `*` matches `/`), verified empirically.
- **Scheduled runs unaffected**: the normalize step forces `dependencies_touched`,
  `ai_code_touched`, and `codeowners_touched` to `'true'` for non-PR events, preserving
  the full scheduled security review.

## Acceptance Criteria Mapping

| Criterion                                      | Implementation                                    |
| ---------------------------------------------- | ------------------------------------------------- |
| Dep allowlist + npm audit gated on manifests   | `dependencies_touched != 'false'`                 |
| AI prompt-injection gated on AI surfaces       | `ai_code_touched != 'false'`                      |
| Dynamic-execution gated on executable surfaces | `docs_only != 'true' && art_only != 'true'`       |
| Secret scan fail-closed                        | Always runs (except `train_promoted`)             |
| CODEOWNERS gated on ownership changes          | `codeowners_touched != 'false'`                   |
| npm audit one authoritative path               | Removed from `ci-advisory` in `ci.yml`            |
| Docs/asset PRs: no Node setup                  | `setup-node` skipped when `docs_only == 'true'`   |
| Classifier failures → broader set              | Fail-safe `!= 'false'` pattern                    |
| Scheduled runs unchanged                       | Normalize step forces all flags `true` for non-PR |

## Closes

nalfeo/Crawler#1697
