# 2026-08-01 — faerie-spark-caster lineage unblock

Apples: 2🍎
Mode: local
Issue: #2516

## Systems touched

sprite-pipeline, enemies

## What changed

- Confirmed the current shipped alias: `faerie-spark-caster -> faerie-blink` in
  `GENERATED_BRIEF_BY_APPEARANCE_KEY`.
- Kept that alias as the runtime fallback for today's shipped art, but changed
  generated-brief resolution to prefer a dedicated bare-id brief from the live
  generated registry when one exists.
- This means approved `faerie-spark-caster` art will start rendering under its
  own request-aligned lineage automatically, without requiring a second code
  change just to stop borrowing `faerie-blink`.
- Added the dedicated `faerie-spark-caster` enemy brief with `judge.enabled:
true` and a small unit test pinning the requested electric-casting direction.
- Added a regression test proving:
  - no-registry resolution still falls back to `faerie-blink`, and
  - registry-backed resolution prefers `faerie-spark-caster` once its own art
    exists.

## Commands run

- attempted `gh issue comment -R nalfeo/Crawler 2516 --body-file /tmp/faerie-spark-plan.md`
  to post the required pre-code plan comment
- `bash scripts/agent/preflight.sh`
- `npm run sprites:placeholder-audit -- --all | cat`
- `ls -l node_modules/.bin/tsx || true; npm ls tsx --depth=0 || true; node -v; npm -v`
- `npm install`
- `npm run test:unit -- tests/unit/faerie-spark-caster-brief.test.ts`
- `npm install --package-lock=false`
- local-only lockfile mirror rewrite attempt to swap Visual Studio package URLs to
  `registry.npmjs.org`, then `npm install` again
- `npm run test:unit -- tests/unit/faerie-spark-caster-brief.test.ts tests/unit/phaser-bridge-sprite-kind.test.ts`
- `npm run verify:fast`
- `npm run sprites:run -- --brief briefs/enemies/faerie-spark-caster.yaml`
- `npm run review:ledger -- init --apples 2 --slug faerie-spark-caster-lineage --title "Add faerie spark caster asset lineage"`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-01-faerie-spark-caster-lineage.review-ledger.json`
- `npm run verify:pr-prereqs`
- `git --no-pager diff --check`
- `git --no-pager status --short`
- multiple read-only `rg` / `view` inspections across generated-art wiring and
  Floor 2 faerie assets
- `parallel_validation` (code review clean; CodeQL skipped due database size)

## Validation outcomes

- `git diff --check` ✅
- issue plan comment post ❌ GitHub API returned `HTTP 403: 403 Forbidden`
- `bash scripts/agent/preflight.sh` ❌ dependency/bootstrap step exited non-zero
- `npm run sprites:placeholder-audit -- --all` ❌ `tsx: not found`
- `npm run test:unit -- tests/unit/faerie-spark-caster-brief.test.ts` ❌ `vitest: not found`
- `npm install` ❌ network/DNS failure fetching npm package tarballs
  (`getaddrinfo ENOTFOUND ms-feed-12.pkgs.visualstudio.com`)
- `npm install --package-lock=false` ❌ npm/arborist failed while recovering the
  partial local install (`Cannot read properties of null (reading 'edgesOut')`)
- lockfile mirror rewrite + `npm install` ✅ local-only repair succeeded; reverted
  before finishing so `package-lock.json` stays unchanged in the repo diff
- `npm run test:unit -- tests/unit/faerie-spark-caster-brief.test.ts tests/unit/phaser-bridge-sprite-kind.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run sprites:run -- --brief briefs/enemies/faerie-spark-caster.yaml` ❌ missing
  `AZURE_OPENAI_ENDPOINT` / `AZURE_OPENAI_API_KEY` in this cloud/CI environment
- `npm run review:ledger -- validate ...faerie-spark-caster-lineage.review-ledger.json` ✅
- `npm run verify:pr-prereqs` ✅
- sprite generation / approval / check-in / observation still not run honestly:
  no `faerie-spark-caster` art was generated or approved in this environment
- `parallel_validation` ✅ no review findings; CodeQL reported 0 alerts but was
  skipped because the JavaScript database is too large in this environment

## Observe-before-done status

- Runtime behavior is now observed through the real Phaser bridge render path in
  `tests/unit/phaser-bridge.test.ts`:
  - `falls back to faerie-blink generated art when dedicated faerie-spark-caster texture is not loaded yet`
- Deterministic before/after captured by this bridge-level regression:
  - before fix: dedicated registry presence with missing dedicated texture could
    fall through to non-alias fallback art.
  - after fix: with both registry entries present but only `faerie-blink-var-0`
    loaded, render resolves to `faerie-blink-var-0` (alias continuity preserved).
- Dedicated-art preference remains covered by
  `tests/unit/phaser-bridge-sprite-kind.test.ts`, where a live dedicated registry
  entry resolves `faerie-spark-caster` over the alias.

## Remaining work once tooling is available

1. Restore local dependencies so `tsx`/`vitest`/sprite CLIs run.
2. Run warmup brief, then `npm run sprites:run -- --brief briefs/enemies/faerie-spark-caster.yaml`.
3. Judge variants per the sprite-judge flow; approve only a clean winner.
4. Run check-in / batch art PR flow if approval succeeds.
5. Re-run `npm run verify:fast` and the targeted unit tests.
6. Observe the approved spark-caster rendering in the real game or a deterministic probe.
