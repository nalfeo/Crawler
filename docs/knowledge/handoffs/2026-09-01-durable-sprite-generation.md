# Session Handoff: Durable-persistence contract for sprite generation

## Date

2026-09-01

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

3🍎 estimated, 3🍎 actual (tooling-only cap)

## What Was Done

Closed the hole that let seven successful 12-candidate directional-neutral sheets
vanish: they were generated through `sprites:run`/`sprites:batch`, approved, and
queued into git, but the source runs existed in neither `generated/runs/**` nor
Azure active/archive storage.

**Root cause.** `scripts/sprites/generate-one.ts` falls back to
`new LocalRunStore(path.join(outputRoot, 'runs'))` whenever a caller does not
inject a store. `cli.ts` and `batch-cli.ts` built the Azure **image provider**
but injected no **run store**, so every direct-CLI run landed only in the
gitignored `generated/runs/**` tree. Approval then published a `sourceRun`
pointer into git referencing content that died with the worktree. The sidecar
path (`sidecar/backend-config.ts`) already forced `SPRITES_RUN_STORE=azure-blob`
and threw `SidecarAzureCredentialsError` — the direct CLIs were the outlier.

A second gap compounded it: even on Azure paths the **exact prompt was never
persisted**, only `promptHash: shortPromptHash(prompt)` in `summary.json`, and
the authored brief YAML was never snapshotted per run. A durable run was
therefore not reproducible from durable storage alone.

**The fix — one shared durability boundary.**

- `scripts/sprites/run-durability.ts` (new) is the single boundary:
  - `resolveGenerationRunStore()` — durable-by-default. Unset `SPRITES_RUN_STORE` - Azure credentials ⇒ `azure-blob` mirrored to local. Unset + no credentials
    ⇒ **throws** naming `npm run setup:azure:env` and the `local` opt-out.
    Explicit `local` ⇒ `ephemeral-explicit`, labelled `LOCAL ONLY … NOT durably
persisted`.
  - `buildRunProvenance()` — pure/deterministic; emits `provenance/brief.yaml`
    (verbatim authored brief) and `provenance/prompt.json` (expanded effective
    brief, exact prompt + `promptSha256`, single-variant prompt, style-guide
    hash, reference sprites, seed frames, `briefSourceSha256`).
  - `ensureRunDurable()` — backfill-then-verify. Sweeps every missing local run
    file into the durable store (`has`-gated ⇒ idempotent), then verifies the
    required set: `provenance/prompt.json` + `summary.json` + ≥1 `sheet-NN.png`.
    Throws `RunDurabilityError` carrying `missingKeys` otherwise.
  - `resolvePublicationDurableStore()` — publication-time resolution that
    deliberately ignores `SPRITES_RUN_STORE=local`.
  - `parseSourceRun()` — tolerant `<briefId>/<runId>` extraction that rejects
    `..` traversal.
- `scripts/sprites/store/mirrored-store.ts` (new) — `MirroredRunStore` writes
  local-first then durable (mirror error propagates ⇒ fail closed), but serves
  `get`/`has`/`list`/`resolve` from the **local** primary. That keeps
  `sprites:approve`, the gallery, and the anchor overlay reading real files, and
  keeps `run-full.ts`'s path-based postprocess artifacts working.
  `conditionalWrites = 'unsupported'` — CAS across two stores cannot be atomic.
- `generate-one.ts` writes provenance **before** the provider retry loop, so a
  run that fails mid-generation still leaves its authored intent durable.
- `cli.ts` / `batch-cli.ts` / `batch.ts` resolve and inject the durable store.
  In `cli.ts` the resolution is hoisted out of the per-brief loop so `--all`
  fails once, up front, before any paid generation.
- `approve-cli.ts` gates git publication: right after `runDir` resolution and
  **before** either approve branch, `ensureApprovalDurable()` backfills + verifies
  and returns new **exit code 5** on failure — no `approveVariant`, no
  `runQueueCommit`, no manifest `sourceRun` pointer.

**Observed contract, deterministically.** `tests/unit/sprites/run-durability.test.ts`
(22 tests) proves ordering (durable `put`s precede git publish), fail-closed
behaviour, backfill idempotency, and partial-failure resume with no duplicate
puts; `approve-cli.test.ts` gains 5 tests proving `runQueueCommit` is never
reached on a durability failure. 45/45 green across
`run-durability` + `approve-cli` + `batch`; full `npm run test:sprites` green.

## Key Decisions Made

- **Mirror, don't swap.** `AzureBlobRunStore.resolve()` returns a blob URL, but
  `sprites:approve`, the gallery, and the anchor overlay all read run artifacts
  as real files, and `run-full.ts` passes `store.resolve(...)` into postprocess
  as a filesystem path. A straight swap to Azure would have broken local review
  and silently dropped the path-written pipeline artifacts.
- **No bypass env var.** Deliberately rejected a
  `SPRITES_ALLOW_UNDURABLE_APPROVAL` escape hatch — that is exactly the
  "defanged guard" antipattern. `ensureRunDurable` **auto-heals** instead:
  backfill-then-verify handles legacy pre-contract runs and partial-upload
  retries with one idempotent primitive, so the guard never needs to be turned
  off to make progress.
- **Publication-time resolution ignores `SPRITES_RUN_STORE=local`.** That env var
  expresses a _generation-time_ offline preference. At publication the only
  question is "is there anywhere durable this run can live?" — backfilling an
  offline-generated run and letting it publish is strictly better than refusing.
  `null` is returned only when no durable target exists at all, preserving the
  fail-closed guarantee.
- **Required key set is minimal and honest.** `provenance/brief.yaml` is
  best-effort (absent when the brief was preloaded or moved); `prompt.json`
  carries the fully-expanded effective brief plus `briefSourceSha256`, which
  satisfies "canonical authored brief _or_ exact effective brief" without
  failing legitimate runs.

## What's Next / Blockers

- **The seven lost runs are unrecoverable.** They exist in no store; only the
  approved PNGs and manifest entries survive.
- **Backfill audit is worth a follow-up session.** Existing `manifest.json`
  entries whose `sourceRun` points at a vanished run will now fail
  `ensureRunDurable` on _re-approve_. A `manifest.json`-wide audit script that
  reports which `sourceRun` values have no durable content would quantify the
  historical damage and let us decide between re-generating, annotating, or
  accepting them.
- `batch.ts` writes `batch-summary.json` via `writeFileSync` to
  `<outputRoot>/runs/_batch/<batchId>/` rather than through the store. It is not
  part of any single run's required key set, so it is out of contract — but it
  is also not durable. Worth folding in if batch provenance ever matters.

## Retrospective

### Lessons Learned

- `store.resolve()` being used as a **filesystem path** in `run-full.ts` is the
  non-obvious constraint that shapes this whole design. Anything that swaps a
  run store for a remote one must check for `resolve()`-as-path callers first,
  or artifacts will silently stop existing.
- The sidecar had solved this correctly a long time ago
  (`sidecar/backend-config.ts`). The bug was _inconsistency_, not absence of a
  policy — worth grepping for "who else calls this factory" before assuming a
  policy is missing.
- `npx vitest --reporter=basic` fails in this repo ("Failed to load custom
  Reporter from basic"). Omit `--reporter` entirely.
- `tests/unit/sprites/queue-repair.test.ts` timed out at 60s inside the full
  148-file `test:sprites` run but passes in 39s standalone. It is a real-git
  test starved under parallel load, not a regression — confirm standalone before
  chasing it.

### Mistakes Made

- Wrote the durability gate into `approve-cli.ts` using
  `resolveGenerationRunStore`, which honours `SPRITES_RUN_STORE=local`. Five
  `approve-cli` tests immediately failed with exit 5 — the early signal that
  _generation-time_ and _publication-time_ store resolution are different
  questions. Split into `resolvePublicationDurableStore` and they went green.
  Next agent: when a guard reads an env var, ask which lifecycle phase that var
  is actually about.
- Two edits collapsed blank lines and merged a JSDoc block onto a function
  signature in `generate-one.ts`. Caught by re-reading the file, not by
  typecheck (both were still valid TS). Re-view every edited region rather than
  trusting a green `tsc`.
- Ran `npm run typecheck` before writing the new test file and treated the green
  as final; the test's `FakeStore` declared `backend = 'fake'`, which is not
  assignable to the `'local' | 'azure-blob'` union. Typecheck covers `tests/` —
  re-run it after adding tests, not just after touching `scripts/`.

### Opportunities for Future Improvement

- Promote this into a deterministic **repo-wide gate**: a check that every
  `createImageProvider()` call site in `scripts/sprites/**` also resolves a run
  store. The class of bug ("built the Azure provider, forgot the Azure store")
  is mechanically detectable and would have caught this at review time.
- `MirroredRunStore.conditionalWrites = 'unsupported'` closes the door on CAS for
  mirrored runs. If a future flow needs conditional writes on a mirrored store,
  it will need a primary-authoritative CAS design rather than a widened mirror.
- The `provenance/prompt.json` record is now rich enough to **replay** a run.
  A `sprites:replay <briefId>/<runId>` command that reconstructs the exact
  generation call from durable storage would turn this safety net into a
  productivity tool.
