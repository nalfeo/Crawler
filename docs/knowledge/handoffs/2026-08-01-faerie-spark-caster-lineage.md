# 2026-08-01 — faerie-spark-caster lineage unblock

Apples: 2🍎
Mode: local
Issue: #2516

## Systems touched

- `briefs/enemies/faerie-spark-caster.yaml`
- `src/shared/generated-assets.ts`
- `src/engine/phaser-bridge/sprite-kind.ts`
- `src/engine/PhaserBridge.ts`
- `tests/unit/phaser-bridge-sprite-kind.test.ts`
- `tests/unit/faerie-spark-caster-brief.test.ts`

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

- `bash scripts/agent/preflight.sh`
- `npm run sprites:placeholder-audit -- --all | cat`
- `ls -l node_modules/.bin/tsx || true; npm ls tsx --depth=0 || true; node -v; npm -v`
- `npm install`
- `git --no-pager diff --check`
- `git --no-pager status --short`
- multiple read-only `rg` / `view` inspections across generated-art wiring and
  Floor 2 faerie assets

## Validation outcomes

- `git diff --check` ✅
- `bash scripts/agent/preflight.sh` ❌ dependency/bootstrap step exited non-zero
- `npm run sprites:placeholder-audit -- --all` ❌ `tsx: not found`
- `npm install` ❌ network/DNS failure fetching npm package tarballs
  (`getaddrinfo ENOTFOUND ms-feed-12.pkgs.visualstudio.com`)
- `npm run verify:fast` not run honestly: blocked by the same missing local
  toolchain
- sprite generation / approval / check-in / observation not run honestly:
  blocked by missing `tsx` + failed dependency restore

## Observe-before-done status

- No new art was generated or approved in this environment.
- Therefore there is **no honest render observation claim** for
  `faerie-spark-caster` yet.
- The code/path change is set up so that once `faerie-spark-caster` art is
  approved into the manifest, runtime resolution will prefer it over the
  fallback alias automatically.

## Remaining work once tooling is available

1. Restore local dependencies so `tsx`/`vitest`/sprite CLIs run.
2. Run warmup brief, then `npm run sprites:run -- --brief briefs/enemies/faerie-spark-caster.yaml`.
3. Judge variants per the sprite-judge flow; approve only a clean winner.
4. Run check-in / batch art PR flow if approval succeeds.
5. Re-run `npm run verify:fast` and the targeted unit tests.
6. Observe the approved spark-caster rendering in the real game or a deterministic probe.
