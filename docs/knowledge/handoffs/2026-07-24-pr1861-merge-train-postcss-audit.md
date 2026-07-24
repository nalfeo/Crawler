# Handoff: PR #1861 merge-train postcss audit recovery

## Date

2026-07-24

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

- Investigated the live merge-train blocker for PR #1861 via GitHub Actions logs.
- Isolated the failure to `Merge Train Validation` run `30117914228`, job `Candidate security verification`.
- Reproduced the blocking advisory locally: `npm audit --audit-level=high` reported `postcss` as a high-severity finding while `fast-uri` remained the already-excepted advisory.
- Applied the smallest repair by updating the committed `package-lock.json` entry for `postcss` from `8.5.15` to the patched `8.5.18` tarball/integrity, which satisfies Vite's existing `^8.5.15` range without changing runtime code.

## Validation

- `npm audit --json --audit-level=high` — now reports only `fast-uri` (the temporary exception), no blocking `postcss`.
- `npm run security:audit` — passed.
- `runtime-tools-gh-advisory-database` for `postcss@8.5.18` — no vulnerabilities found.
- `runtime-tools-secret_scanning` on `package-lock.json` — clean.
- `npm run verify:fast` — environment-blocked in this sandbox after fetching `origin/main`; local install lacks repo binaries (`typescript`, `eslint`, `tsx`, `vitest`) because dependency restore to `ms-feed-12.pkgs.visualstudio.com` is DNS-blocked here.
- `npm run security:check` / `npm run test:unit` — same environment limitation (`tsx` / `vitest` missing from the incomplete install).

## Next / Follow-up

- Push the lockfile repair so PR #1861 gets a fresh branch head and a new merge-train validation candidate.
- Let GitHub run the authoritative install + validation on hosted runners, where package resolution is available.
