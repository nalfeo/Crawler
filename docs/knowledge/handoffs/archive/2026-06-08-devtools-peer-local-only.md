# Session Handoff: Local-only devtools peer entrypoint

## Summary

Added a new `devtools` surface as a peer to labs for local development only. The entrypoint is available through `npm run devtools` and opens `devtools.html`. Build/deploy controls were updated so this surface is never published to GitHub Pages environments.

## Files Touched

- `package.json`
- `vite.config.ts`
- `devtools.html`
- `src/devtools-main.ts`
- `.github/workflows/deploy.yml`
- `.github/workflows/promote-to-prod.yml`

## Verification Run

- `npm run typecheck`
- `npm run lint`
- `npx vitest run --project unit --reporter=dot`
- `DEPLOY_ENV=dev BUILD_OUTDIR=temp-build/dev npm run build` (confirmed `temp-build/dev/devtools.html` is absent)
- `npm run build -- --mode devtools` (confirmed `dist/devtools.html` is present)

## Unresolved Issues

- None identified for this change.

## Recommended Next Steps

1. Add first real devtools modules (for example ECS inspector, seeded run launcher, and perf overlay) behind this new local-only shell.
2. Keep new devtools tooling out of deploy targets by retaining the current dual guard pattern (Vite input gating + workflow leakage checks).
