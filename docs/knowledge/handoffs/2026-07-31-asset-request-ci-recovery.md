# Handoff: asset-request CI recovery

## Date

2026-07-31

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, ci-policy

## Apples

2🍎 estimated, 2🍎 actual (exact)

## Summary

- Recovered the rebased asset-request auto-close PR by tracing the reported `ci`, `Lightweight Checks`, and `Merge gate` failures back to one concrete `Lightweight Checks` formatting error in `scripts/sprites/checkin.ts`.
- Confirmed the aggregate `ci` and `Merge gate` jobs were only red because `Lightweight Checks` failed.
- Confirmed the stale dead-code finding from the older failing head (`src/shared/generated-assets.test-seams.ts`) no longer exists after preflight rebased the branch onto current `main`.
- Applied the smallest code change: Prettier-compatible wrapping for `FLOOR2_RUNTIME_BRIEF_IDS` with no logic change.

## Files touched

- `scripts/sprites/checkin.ts`
- `docs/knowledge/handoffs/2026-07-31-asset-request-ci-recovery.md`
- `docs/knowledge/review-ledgers/2026-07-31-asset-request-ci-recovery.review-ledger.json`

## Verification

- GitHub Actions MCP: inspected run `30610439984` and jobs `91094391056` (`ci`), `91091844627` (`Lightweight Checks`), and `91094173302` (`Merge gate`).
- `npx prettier --check scripts/sprites/checkin.ts`
- `parallel_validation` → code review: 0 findings; CodeQL: 0 alerts reported
- `npm ci` *(environment-blocked: `getaddrinfo ENOTFOUND ms-feed-25.pkgs.visualstudio.com` for `postcss-8.5.22.tgz`)*
- `npm run format:check` *(environment-blocked: project `prettier` binary unavailable because dependencies are not installed in this sandbox)*

## Unresolved / next steps

- Branch CI rerun is the authoritative full verification path because this sandbox still cannot install the locked dependencies from the mirrored package host.
