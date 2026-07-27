# Session Handoff: Stop caching mutable coordination docs and forward conditional writes

## Date

2026-07-27

## Persona

Producer → Sprite Engineer

## Systems touched

asset-pipeline, agent-tooling

## Apples

3🍎 estimated, 3🍎 actual (exact — see docs/knowledge/metrics/apples/2026-07-27-store-cache-coordination-docs.json)

## What Was Done

Fixed two storage defects that had been silently corrupting the theme-equipment
pipeline's durable state, plus the canvas UX symptom that exposed them.

**Defect A — permanently stale reads.** `isCacheableKey` excluded exactly one key
family, so `theme-sets/<id>/state.json` was cached read-through like an immutable
PNG. It is not immutable: it is the pipeline's durable state document and carries
`stateRevision`, the optimistic-locking token. `CachingRunStore`'s coherence
protocol (per-key mutation token + global list epoch) lives in the **local** cache
dir, so a GitHub Actions runner that advances the authoritative blob can never
invalidate a laptop's copy. Observed in production, same process: the local read
returned 73562 bytes at `stateRevision` 40 while Azure held 130148 bytes at
`stateRevision` 59.

**Defect B — silent compare-and-swap downgrade.** `getWithETag`/`putConditional`
are optional on `RunStore`. `CachingRunStore` implemented neither, so
`saveThemeEquipmentSetState`'s `if (store.getWithETag && store.putConditional)`
was always false in production. Every save fell through to check-then-write
against the stale cache — which passed — and then did an unconditional overwrite.
Two defects compounding: read stale, then clobber.

Fixes: a new `scripts/sprites/store/cache-policy.ts` registry of coordination-document
predicates; `CachingRunStore` now forwards CAS (as **optional instance fields**, never
prototype methods, so feature detection stays honest); a new
`conditionalWrites: 'atomic' | 'best-effort' | 'unsupported'` capability on `RunStore`;
and a hoisted fail-loud gate in `saveThemeEquipmentSetState` that refuses any
`azure-blob` backend lacking atomic CAS _before_ reading or writing anything.

The canvas run button now names the work it will do, and its dispatch handler
replaced `confirm()`/`alert()` with an inline notice.

**Observed in the running canvas** (rule #9) — before: the button read "Run / rerun
unresolved items on GitHub", and after the first label attempt it read "Re-judge
collection cohesion on GitHub" while a click would have regenerated all 18 briefs.
After: "Regenerate 18 briefs on GitHub", matching what `runThemeEquipmentSetPhase`
actually does. Screenshot in the session artifacts.

## Key Decisions Made

- **Deny-list registry, not an inverted default.** The plan reviewer wanted
  cacheability defaulted to non-cacheable with an opt-in immutable allow-list.
  Shipped a centralized deny-list instead: `CachingRunStore.get()` throws
  `StoreNotFoundError` for a non-cacheable key when `offline` is set, so inverting
  the default would silently break the documented `CRAWLER_AZURE_OFFLINE=1`
  guarantee for **every** artifact. The registry requirement was honored — all four
  coordination documents live in one module. Recorded as `plan_divergence: minor`.
- **Two mutable families audited and deliberately left cacheable**:
  `<briefId>/<runId>/summary.json` and `workflow-state/briefs/**`. They are content,
  never read to make a locking/claim/resume decision, a same-machine `put()`
  invalidates them coherently, and offline mode serves reads only from cache.
  Consequently the assertions at `caching-run-store.test.ts:399-405,429-435` (which
  assert these ARE cached) are **correct and were left unchanged** — contrary to the
  plan reviewer's expectation that they encoded the bug.
- **Capability flag, not feature detection.** `LocalRunStore` implements both CAS
  methods but its `stat`-then-`put` is not atomic across processes, and a wrapper can
  expose the methods while the underlying guarantee is weaker. "Both methods exist"
  is therefore not evidence of atomic CAS, so the gate keys off `conditionalWrites`.
- **All three fixes in one PR**, per explicit human direction, even though the
  reviewer suggested splitting the canvas UX change out.

## What's Next / Blockers

- `classic-fantasy-basic-leather` sits in the `briefs` phase awaiting per-item
  review in the canvas. The loop is: **Run → review items → approve collection →
  Advance → Run**. Collection approval must come _after_ the final `run-phase`,
  because `applyThemeSetItemReview` resets the whole `phases[phase]` record on any
  verdict change and wipes `collectionJudge`.
- Still outstanding from PR #2032: dispatch `init` for `edo-samurai`; audit sibling
  `scripts/sprites/*-cli.ts` entrypoints for the `process.exit()` libuv crash pattern.
- Deferred (~3🍎): the revision-loop PR — make a set-level `down` drive a set-wide
  revise on `run-phase`, thread `feedback` into generation prompts, and add a
  sanctioned way to amend an initialized set's plan/`themeDesignLanguage` without a
  manual state teardown.

## Retrospective

### Lessons Learned

- **A read-through cache is a correctness decision, not a performance one.** The
  cacheability predicate was an inline `startsWith` check with a single exclusion.
  The moment a mutable coordination document lands in a store fronted by that cache,
  it is silently pinned forever on every machine that isn't the writer. New key
  families now have to be classified in `cache-policy.ts` rather than defaulting in
  by omission.
- **Optional interface members make silent downgrades easy.** `if (store.getWithETag
&& store.putConditional)` reads like a safe capability check but has no `else`
  that fails — it just quietly picks the weaker path. The fix pattern that worked:
  add an explicit capability field, and make the _caller_ refuse rather than degrade.
- **Assign forwarded optional methods as instance fields, never prototype methods.**
  A prototype method makes `typeof store.putConditional === 'function'` true even
  when the inner store has no CAS, so every caller's feature detection lies.
- `tests/unit/sprites/**` is **excluded from the `unit` vitest project** — sprite
  tests run under `npx vitest run --project sprites <filter>`. Running them under
  `--project unit` reports "No test files found", which looks like a passing run.
- Verified the new tests were genuinely load-bearing by temporarily neutering the
  theme-set predicate: 3 tests failed, including "reads a coordination document
  written by another machine". A regression test you haven't seen fail is a guess.

### Mistakes Made

- **Hit the renderer backtick hazard again** — `renderer.mjs` serves its entire
  browser-side script from inside a template literal, so a backtick _anywhere_,
  including inside a JSDoc comment, is a syntax error. It bit me twice this session
  (once in a doc comment, once in an inline comment referencing a variable name).
  Early signal: `node --check .github/extensions/theme-equipment-review/renderer.mjs`
  fails pointing at a line that looks syntactically innocent. Run it after every
  renderer edit; do not wait for the canvas to break.
- **Wrote the first run-button label against an assumption instead of the runner.**
  `runPhaseWork()` counted rejected items plus items with zero artifacts, but
  `runThemeEquipmentSetPhase` skips only `isThemeSetItemResolvedForPhase`, so it
  regenerates unreviewed items that already have artifacts. The button therefore
  said "Re-judge collection cohesion" while a click would have regenerated all 18
  briefs — the exact class of misleading UI the user had just complained about, and
  I shipped a new instance of it while fixing the old one. Caught by code review, not
  by me. When a UI element describes what a backend will do, read the backend loop.
- **Put the atomicity gate only on the fallback branch.** A store exposing CAS
  methods with a non-atomic guarantee sailed straight past it. Caught in review
  round 1. The gate belongs _above_ branch selection, because the branch selection
  is itself the thing that can be wrong.
- **Assumed `saveThemeEquipmentSetState` bumps `stateRevision`.** It does not — the
  mutation helpers do. Two new tests failed on first run because of it. Read the
  function before asserting on its return value.

### Opportunities for Future Improvement

- **No deterministic harness for `renderer.mjs`.** The run-button label bug was
  caught by a human reading code and confirmed by driving a live canvas with
  Playwright. Because the client script is a template-literal string with no module
  boundary, none of its logic is unit-testable. Extracting the pure helpers
  (`runPhaseWork`, `runPhaseLabel`) into a real importable module the server inlines
  would make the "does the label match the runner?" question a test instead of an
  eyeball.
- **Audit the other `RunStore` consumers for the same optional-method trap.**
  `saveThemeEquipmentSetState` is currently the only CAS consumer, but the sidecar
  workflow queue and issue-checkpoint ledgers are coordination documents doing
  check-then-write without conditional writes at all. They were made non-cacheable
  here, which fixes the stale-read half, but not the lost-update half.
- **A cache-policy classification test that fails on unregistered new key families**
  would turn this from a convention into a gate. Today a new coordination document
  is cacheable by default and nothing complains until data is lost.
