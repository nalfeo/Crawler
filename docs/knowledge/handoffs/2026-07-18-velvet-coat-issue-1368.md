# Handoff: issue #1368 velvet-coat brief

**Date:** 2026-07-18
**Persona:** Graphics Designer
**Apple estimate:** 🍎 (art-only)

## Summary

Handled the local portion of asset request issue #1368 by adding the canonical
bare-id item brief `briefs/items/velvet-coat.yaml` for the Floor 2 torso gear
icon. The brief preserves the consumer-facing identity as `velvet-coat`, which
is the item-id-safe form the item-art approval path expects for runtime
resolution.

## Process note

Issue #1368's intake requested a detailed plan comment before code changes. The
minimal brief + blocker handoff landed before that issue comment existed. During
this PR recovery session I attempted to post the retroactive issue plan with
`gh issue comment 1368 --repo nalfeo/Crawler --body-file /tmp/velvet-coat-issue-1368-plan.md`,
but GitHub write auth in this environment returned `HTTP 403: 403 Forbidden`.

Retroactive implementation plan for the minimal branch scope:

- Preserve the bare runtime-safe id exactly by authoring
  `briefs/items/velvet-coat.yaml` as the source-of-truth brief.
- Attempt the normal sprite pipeline entrypoints available from this session,
  but do not bypass the Azure-backed generate/judge/approve flow with manual
  art if credentialed access is unavailable.
- Record the real blocker and the next-step recovery path so a credentialed
  follow-up can resume the normal pipeline without name drift.

I attempted the required pipeline flow next, but this session cannot reach the
Azure-backed generation path:

- `npm run sprites:run -- --brief briefs/items/pebble.yaml` failed immediately
  with `Missing required env var 'AZURE_OPENAI_ENDPOINT'`.
- `npm run setup:azure:env` reported `Cloud/CI environment detected - skipping local .env.local setup.`
- Direct retrieval of the previously generated remote run summary for
  `velvet-coat-v1` failed because `crawlersprites.blob.core.windows.net` is not
  resolvable from this environment.

Because Azure/provider access and blob retrieval are both blocked here, I did
not bypass the sprite pipeline with manual/ad-hoc art and did not claim a judge
or approval verdict I could not actually perform.

## Systems touched

sprite-pipeline, sprite-workflow

## Files touched

- `briefs/items/velvet-coat.yaml`
- `docs/knowledge/handoffs/2026-07-18-velvet-coat-issue-1368.md`

## Verification

- `npm run sprites:run -- --brief briefs/items/pebble.yaml` → failed fast on
  missing `AZURE_OPENAI_ENDPOINT`
- `npm run setup:azure:env` → skipped in cloud/CI, so no local `.env.local`
  bootstrap occurred
- `curl -I https://crawlersprites.blob.core.windows.net/generated-runs/velvet-coat-v1/2026-07-18T02-06-38-780b2f2a/summary.json`
  → `Could not resolve host`
- `npm run verify:fast` (run after the repo change)

## Observe before done

No runtime visual observation was possible because no generated/approved sprite
was produced in this session. The repo change is only the authored brief plus
this handoff.

## Blockers / next steps

1. Run the normal Azure-backed sprite flow from an environment that has the
   repo's `AZURE_OPENAI_*` and Azure Storage vars available, or dispatch the
   existing `asset-request.yml` workflow again.
2. If the existing remote run `velvet-coat-v1 / 2026-07-18T02-06-38-780b2f2a`
   is retrievable from a networked environment, judge the sheet, then approve a
   clean variant. For item art, `approve.ts` will canonicalize `velvet-coat-v1`
   to bare `velvet-coat` on check-in.
3. Only after approval should the art be checked in / batched into the art-only
   PR lane.
