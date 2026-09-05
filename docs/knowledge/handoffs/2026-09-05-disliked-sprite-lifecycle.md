# Handoff: Disliked sprite lifecycle

## Date

2026-09-05

## Persona

Producer coordinating Systems Engineer, DevOps Engineer, and QA Engineer slices.

## Systems touched

sprite-pipeline, sprite-workflow

## Summary

- Added ADR 0105 and one shared normalized-concept contract for runtime and
  tooling aliases such as `npc-welcome-goon`, `welcome-goon`, and
  `welcome-goon-v2`.
- Preserved exact NPC and set-piece pins while making variant-selectable spawned
  entities choose accepted, non-disliked variants reproducibly from their
  per-entity seeded appearance roll in both real and headless simulation paths.
- Added a transactional disliked lifecycle with deterministic dry-run inventory,
  tracked plus pending dislike reconciliation, stale-key recovery, all-disliked
  retention, acceptance-time cleanup, exact-pin repoint-or-abort, rollback,
  tombstones, and post-apply closure validation.
- Excluded exact disliked references and every same-normalized-concept alias from
  generation references without generating or auto-approving replacement art.
- Removed 28 disliked variants from mixed groups (28 manifest shards and their
  manifest-directed PNGs), retained 25 all-disliked groups, promoted 0 pending
  dislikes, and preserved unmatched stale annotation `faerie-boss-var-1`.

## Files touched

- Runtime and architecture: `docs/knowledge/adr/0105-normalized-seeded-sprite-variant-selection.md`,
  `src/shared/sprite-concepts.ts`, `src/shared/generated-assets.ts`, spawn/world
  seams, engine sprite resolution, main-game preload, and the headless runner.
- Lifecycle tooling: `scripts/sprites/disliked-lifecycle*.ts`, approval,
  queue/reconciler/repair, reference selection, backlog, generation, and sidecar
  acceptance seams.
- Asset state: `public/assets/generated/sprite-editor-annotations.json`, 28
  deleted shard/PNG pairs, `src/shared/data/npc-sprite-map.json`, and exact boss
  status pins.
- Regression coverage: lifecycle, approval/queue/reconcile/reference tests,
  generation/manifest integration tests, and real/headless seeded runtime tests.

## Verification

- Pre-mutation dry-run and apply both reported 28 removed, 25 retained groups,
  and 0 pending promotions.
- Post-apply dry-run reported 0 removable, 25 retained groups, 0 pending
  promotions, and 0 reference updates; persisted tombstone closure passed.
- After review hardening removed name-similarity deletion authority, the final
  dry-run reported 0 removable, 20 provenance-backed retained groups, and 7
  unresolved stale annotation keys. Those unresolved assets remain preserved;
  only exact keys, valid tombstones, or explicit source-run provenance can
  authorize future deletion.
- Combined targeted lifecycle/runtime suite: 227/227 passed.
- Independent QA hard-gate matrix: 494 passed, 1 intentional environment-gated
  skip; all nine lifecycle requirements passed.
- Final post-review lifecycle/runtime matrix: 336/336 passed. Review fixes also
  isolated cosmetic variant rolls from gameplay RNG, preserved cumulative
  tombstone-authorized queue deletions across later approvals and queue repair,
  and extended closure to live test/data/tool references.
- `npm run verify:fast` passed after integration.
- The originating worktree confirmed all five unapproved generated
  `sheet-00.png` candidates still exist with nonzero sizes; neither integrated
  commit contains a `generated/runs/**` path.

## PR #3234 generic extraction audit

- Incorporated normalized alias exclusion, including the
  `npc-welcome-goon`/`welcome-goon` regression, and import-safe pure lifecycle
  and selector seams.
- Preserved current-main durability, checkpoint, resumability, and
  `load-reference-pngs` behavior; did not port in-memory-only provenance,
  palette-membership stubs, incomplete pixel-art dependencies, or divergent
  request context.
- Left Workflow preview extraction to its dedicated owner and did not modify
  `.github/extensions/workflow/**`.

## Unresolved issues

None for the confirmed lifecycle contract. Replacement generation remains
human-reviewed by design; the 25 retained all-disliked groups stay available
until explicit replacement acceptance.

## Recommended next steps

Allow the normal judged/human-reviewed generation path to produce replacements
for retained concepts. Explicit acceptance will invoke the transactional cleanup;
do not auto-approve candidates.

## Apples

Estimated 5🍎, actual 5🍎 — 🎯 Exact. The work spanned a durable cross-system
contract, destructive asset transactions, runtime determinism, checked-in data,
and independent integration verification.
