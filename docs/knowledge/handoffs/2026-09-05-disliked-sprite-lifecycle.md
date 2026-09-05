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
  manifest-directed PNGs), retained 20 provenance-backed all-disliked groups,
  promoted 0 pending dislikes, and preserved 7 unresolved stale annotation keys.

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
- Fifteen initial cleanup tombstones are explicitly marked as a one-time
  pre-hardening migration. Each records the deleted shard's `sourceRun` and
  `variantIndex` corroboration; future lifecycle runs cannot reuse name
  similarity as deletion authority.
- Final post-review lifecycle/runtime matrix: 739 passed, 1 intentional
  environment-gated skip; Sprite Editor persistence tests passed 9/9 and all
  nine lifecycle requirements passed.
- Review fixes isolated cosmetic variant rolls from gameplay RNG, shared the
  harvestable roll selector, rejected manifest-level disliked references,
  preserved cumulative tombstone-authorized queue deletions across later
  approvals and queue repair, paired nested shard/PNG promotion paths
  atomically, and made variant identity resolution fail closed before approval.
- Every explicit human acceptance surface now uses the same concept-scoped
  lifecycle transaction, including sidecar accept, frame sequences, and icon
  batches. Queue-tip tombstones preserve absent-vs-explicit-clear semantics,
  stale unresolved dislikes are conservatively excluded from generation
  references without gaining deletion authority, and closure still checks every
  historical tombstone in a single bounded scan per live reference file.
- Final certification made the human approval CLI refuse before mutation under
  CI; restored manual anchors and safe `briefs/**/*.yaml|yml` type context for
  store-backed sidecar approvals; persisted canonical durable `sourceRun`
  pointers; added strict sidecar hard-block overrides; and made brief-store
  failures abort rather than publish incomplete metadata.
- Icon-batch acceptance now scopes lifecycle cleanup and reference
  self-exclusion per cell concept. Annotation/removal-only transactions publish
  to `assets/queue`, and AST-backed source guards classify every approval caller
  and manifest-concept derivation.
- A lifecycle-changing sidecar `/accept` uses `assets/queue` as its single
  durable commit point and skips the superseded issue publisher. The response
  identifies the queue branch, so no later remote failure can trigger a
  local-only rollback after the complete transaction is already durable.
  Persisted exact replacement keys make re-accept idempotent on the same queue
  path without rerouting later accepts for the same concept. Local and remote
  approvals now fail before mutation unless complete run provenance is durably
  present or backfilled.
- Publication durability now also requires `summary.json` brief/run identity
  to match its storage coordinates before any backfill or lifecycle mutation,
  and pending-overlay promotion preserves historical tombstones and provenance.
- A matching legacy `asset-checkin` record no longer short-circuits explicit
  re-acceptance when the scoped preflight finds cleanup or exact replacement
  retry work. A converged exact match now returns its existing queue record
  before unrelated changed assets can leak into a newly filed legacy issue;
  conflicting or unverifiable queued content still refuses early.
- Queue reconciliation now requires valid JSON with an object-valued `sprites`
  map before promoting the annotations document. Malformed annotation-only
  changes are withheld, and malformed deletion audits atomically withhold both
  the annotations and their complete deletion set while unrelated art continues.
- Lifecycle apply skips annotation writes when its per-key delta is empty. When
  updates exist, it re-reads the latest tracked document and applies only the
  owned keys, preserving unrelated Sprite Editor changes instead of replacing
  the whole planning-time snapshot.
- Placeholder exclusion remains the explicit ADR 0105 `ELG-001` behavior:
  placeholder-only item concepts use the existing non-generated UI fallback,
  and non-melee carried weapons remain hidden until eligible real art exists.
- The final review round also unified tooling concept keys with the runtime
  normalizer, made conscious icon-batch hard-block overrides durable, added an
  always-on repository tombstone closure test, let the hourly reconciler
  quarantine invalid lifecycle deletions without blocking unrelated art, and
  scoped pending-overlay promotion to the explicitly accepted concepts.
- Final local evidence: `npm run test:sprites` passed 2,575 tests with 2
  intentional environment-gated skips; the runtime integration matrix passed
  165/165 while driving the real `src/engine/sim/simulation-step.ts` and
  `src/game/ai/simulation-step.ts` pipelines with fixed seeds; Sprite Editor
  tests passed 57/57; the certification-focused matrix
  passed 250 tests with 1 Windows symlink-permission skip; lifecycle closure
  remained 0 removable / 20 retained / 7 unresolved / 0 deferred / 0 pending /
  0 reference updates; `npm run verify:fast` passed 4,223 tests with 1
  environment-gated skip; and the exact replacement-retry/provenance follow-up
  passed 515 tests with 1 intentional environment skip across the 12 affected
  sprite suites, 278/278 Workflow extension tests, and a 437/437 `verify:fast`
  changed-test selection. The final legacy-queue ordering follow-up passed
  153/153 focused sidecar tests and its 172/172 `verify:fast` selection. The
  exact-head closure fixes passed 356/356 focused lifecycle, queue, sidecar,
  reconciler, and real `runHeadless` tests; typecheck passed; repository closure
  remained 0 removable / 20 retained / 7 unresolved / 0 deferred / 0 pending /
  0 reference updates; and `verify:fast` passed 661/661 changed tests.
- The final durability review made `/accept` reconcile the exact manifest key,
  manifest-directed PNG path, and recorded content hash against both legacy
  issues and the canonical `assets/queue` branch before mutation. Production
  inspection uses a unique temporary Git ref so concurrent sessions cannot
  overwrite a shared remote-tracking ref. Exact matches return the existing
  queue record without sweeping unrelated changed art; partial pairs,
  unverifiable hashes, and content conflicts fail closed.
- Queue repair now rejects structurally malformed, empty, or missing lifecycle
  annotations instead of interpreting them as an empty authority map, so
  rebuilding from `main` cannot resurrect a tombstone-authorized deletion. The focused queue,
  reconciler, sidecar, and real-Git inspection matrix passed 277/277; lifecycle
  closure remained 0 removable / 20 retained / 7 unresolved / 0 deferred /
  0 pending / 0 reference updates; and the final changed-test `verify:fast`
  selection passed 810/810.
- The next independent review hardened the same boundaries further. Durable
  queue identity now verifies the shard's exact `spriteName`, manifest-directed
  path, recorded hash, and the actual queued PNG SHA-256 through bounded,
  non-interactive Git calls. Queue repair still discards the explicitly modeled
  partial-pair corruption, but refuses before rewriting if it would lose a later
  complete asset pair, brief/catalog write, or unrelated valid annotation.
  Store-backed approval hydration requests an authoritative listing, and
  `/approve` plus `/accept` now preserve structured retry/conflict status for
  check-in and queue-commit failures. The expanded focused matrix passed
  179/179; lifecycle closure remained 0 removable / 20 retained / 7 unresolved /
  0 deferred / 0 pending / 0 reference updates; and `verify:fast` passed
  816/816.
- The final review follow-up keeps queue identity byte-exact by reading Git PNG
  blobs as raw buffers, validates the regression with a non-ASCII PNG signature,
  and rejects reserved source-run identities before allocating a hydration
  directory. Deletion-only reconciliations now carry the exact queue SHA in
  their `Queue-Source` trailer.
- Partial icon batches now derive lifecycle scope from replacements that were
  actually materialized by approval. A skipped cell remains disliked and
  retained instead of rolling back successful cells, while single-candidate
  exact pins still fail before mutation and multi-cell transactions validate
  pins before lifecycle cleanup/publication with full rollback protection.
  The focused durability matrix passed 314/314; typecheck passed; lifecycle
  closure remained 0 removable / 20 retained / 7 unresolved / 0 deferred /
  0 pending / 0 reference updates; and `verify:fast` passed 721/721 changed
  tests.
- Two exact-head reviews then found stale-state edge cases and all were closed:
  icon batches report the exact keys actually approved instead of inferring
  acceptance from old on-disk art; rollback snapshots expand to the final plan
  and merge only transaction-owned annotation keys; provenance-resolved stale
  dislikes migrate to the reaccepted key; and queue publication clears a
  pre-existing tombstone whenever accepted art republishes that key.
- Reconciliation now ignores malformed historical tombstones that name no path
  in the current deletion set and atomically withholds lifecycle deletion plus
  annotations when an orphan branch would overlay the same art. `/approve` and
  `/accept` also share the `not-durable` error contract. The broader approval,
  queue, repair, reconcile, and sidecar matrix passed 464/464; lifecycle closure
  stayed 0 removable / 20 retained / 7 unresolved; and the resulting
  `verify:fast` selection passed 678/678.
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
- Left Workflow preview/reference extraction to its dedicated owner. The only
  `.github/extensions/workflow/**` integration is the minimal acceptance-result
  handling needed to represent canonical `assets/queue` success when no legacy
  asset-checkin issue is created.

## Cleanup inventory

- Removed 28 exact variants: `baseball-bat-var-6`,
  `beetlefolk-boss-var-0`, `cactusfolk-boss-var-0/1`,
  `crabfolk-boss-var-10`, `gnome-boss-var-7`, `imps-boss-var-5`,
  `kobold-boss-var-0`, `myconid-boss-var-0`,
  `npc-spell-broker-var-1`, `npc-sweaty-merchant-var-0`,
  `npc-welcome-goon-var-0`, `rat-king-var-7`, `rat-queen-var-7`,
  `ratfolk-elite-underboss-var-6`, `sweaty-merchant-var-5/7/9/10`,
  `toadkin-boss-var-0`, `welcome-goon-var-3/4/5/6/7/9/10`, and
  `welcome-room-floor-plate-cable-run-var-4`.
- Retained 20 provenance-backed all-disliked groups:
  `batfolk-boss`, `cave-floor`, `cave-wall`, `classified-dossier`,
  `crabfolk-armored`, `directors-cue-card`, `faerie-boss`, `geese-boss`,
  `goblin-boss`, `imp-flinger`, `llama-boss`, `molefolk-boss`,
  `panda-boss`, `panda-bruiser`, `player-walk-cycle`, `raccoons-boss`,
  `ratfolk-boss`, `slime-rat-boss`, `snailfolk-boss`, and
  `welcome-room-cable-coil`.
- Preserved 7 unresolved stale keys without deletion authority:
  `ability-icon-fireball-v1-var-11`, `bent-pipe-v1-var-1`,
  `bent-pipe-v1-var-5`, `faerie-boss-var-1`,
  `frost-lichen-v1-var-12`, `green-slime-baby-v1-var-2`, and
  `tile-boss-staircase-floor-v2-var-10`.

## Unresolved issues

None for the confirmed lifecycle contract. Replacement generation remains
human-reviewed by design; 20 provenance-backed all-disliked groups stay
available until explicit replacement acceptance, while 7 unresolved stale
annotation keys remain preserved without deletion authority.

## Recommended next steps

Allow the normal judged/human-reviewed generation path to produce replacements
for retained concepts. Explicit acceptance will invoke the transactional cleanup;
do not auto-approve candidates.

## Apples

Estimated 5🍎, actual 5🍎 — 🎯 Exact. The work spanned a durable cross-system
contract, destructive asset transactions, runtime determinism, checked-in data,
and independent integration verification.
