# Session Handoff: Deterministic controls for the top regression classes

## Date

2026-08-02

## Persona

Producer → DevOps Engineer

## Systems touched

ci-policy, sprite-pipeline, docs-tooling

## Apples

3🍎 estimated, 3🍎 actual — tooling-only (guards, health checks, lint rule, CI wiring),
capped at 3🍎 by the complexity policy's tooling ceiling. Full JSON in
`docs/knowledge/metrics/apples/2026-08-02-regression-prevention-guards.json`.

## What Was Done

Turned the five highest-yield classes from a 20-regression intervention retrospective into
deterministic checks. See ADR 0082
(`docs/knowledge/adr/2026-08-02-regression-class-deterministic-controls.md`) for the full
class→control mapping and the alternatives that were rejected.

Shipped:

1. **`check:registry-integrity`** (class D) — duplicate/blank/non-string ids within a
   registry file _and across sibling files sharing one logical id namespace_. 172 entries,
   4 files, 3 namespaces. The cross-file case is the one per-file Zod loaders structurally
   cannot see.
2. **`check:asset-integrity`** (class D/F) — shard ↔ PNG ↔ `contentHash` triple over the
   **entire** committed corpus (641 shards, 516 hashes verified, ~90–300 ms).
3. **Local silent-revert gate** (class A) — `scripts/agent/ci/merge-scope.sh` emits
   `has_merge` / `can_run`; `verify:fast` runs `check:silent-reverts` only when the branch
   contains a merge commit, and **skips (never fails)** on a shallow clone. Plus the
   `shell-blunt-merge-strategy` copilot guard denying `git merge -X theirs` / `-X ours`.
4. **`check:allowlist-expiry`** (class C) — uniform, fail-closed governance over all 5
   allowlists (80 entries): reason + unexpired `expiresOn`, or reason + tracking ref +
   removal condition. An unregistered allowlist-shaped export is itself a finding.
5. **`crawler/no-rethrow-in-automation-catch`** (class B) — ESLint rule over the
   merge-train and ci-recovery trees, narrowed to **loop-scoped** rethrows, plus a fix to
   the live `reconcile.mjs` deadlock.

**Observed in the real artifacts, not just in tests** (rule #9):

- `npm run check:asset-integrity` on the committed corpus — **before**: 1 blocking finding,
  the orphaned `rhea-vale-v1-var-0-walk.json` shard; **after** deleting the orphan: 641/641
  shards clean, 0 blocking.
- `npm run check:extensions` — **before**: 2 bare-import violations
  (`asset-search/extension.mjs` → `minisearch`, `lib/index-builder.mjs` → `yaml`);
  **after**: 114 files clean. Verified the runtime path end-to-end, not just the guard:
  `createRepoRequire(REPO_ROOT, …)('minisearch')` returns the constructor and a real
  index/search round-trip succeeds, and `buildCorpus()` loads 517 docs through the
  converted `yaml` require.
- `npx eslint '.github/scripts/{merge-train,ci-recovery}/**/*.mjs'` — **before** narrowing:
  24 errors; **after**: 1 (the real `router.mjs` retry loop, then explicitly dispositioned).
- `npm run verify:fast` green end-to-end: 138 files / 2222 tests, all three new checks
  running in step 3, silent-revert gate correctly printing its skip text on this shallow
  clone. `npm run test:guards` green: 2352 tests.

**Two real latent defects on main were found and fixed by the new checks during this
change** — which is the strongest available evidence that the controls work:

- `public/assets/generated/entries/rhea-vale-v1-var-0-walk.json` — an orphan shard whose
  PNG was intentionally deleted by PR #2322 and which was silently resurrected by chore
  commit #2663. Confirmed via `git log --diff-filter=D` and confirmed unreferenced by any
  loader before deletion. This is itself a class-A silent revert that had been sitting
  undetected.
- Two bare imports in the `asset-search` extension — a live instance of the exact class-G
  "extension silently not loading" regression that `check:extensions` was built for.

## Key Decisions Made

- **The ESLint rule is narrowed to loop scope, deliberately trading recall for precision.**
  The un-narrowed rule reported 24 sites; 23 were ordinary helper-level error plumbing.
  Shipping that version would have created exactly the class-C guard-false-positive problem
  the same retrospective indicts. Loop scope isolates the shape with real blast radius: a
  throw escaping `for (const pr of queued)` abandons _every remaining queued PR_.
- **Novel errors are made loud, not silent.** An existing test asserted `throw err` must be
  present, with the stated intent "so novel failures stay visible". Rather than override
  that intent, the fix preserves it by a different mechanism: non-422 statuses log a
  distinct greppable `unexpected-status:` marker and the loop continues. Visibility is kept;
  the process crash is removed. The test was updated to pin the new contract and now
  asserts `not.toContain('throw err')`.
- **A pre-existing failure was fixed rather than deferred.** `check:extensions` was red on
  two violations that predate this branch. Per repo rule #7 they were fixed here — and they
  turned out to be a live recurrence of a class already in the retrospective.
- **The orphan shard was deleted rather than allowlisted.** The agent-authored corpus test
  had shipped a `KNOWN_ORPHAN_SHARDS` tolerance list containing it. Tolerating a defect the
  guard exists to catch is how these classes recur, so the shard was removed and the list
  reduced to empty with a comment stating it must stay at zero.
- **Local-only skips can never weaken a gate.** Both `merge-scope.sh` and the size/weight
  precedent skip on _tooling state_ (shallow clone), never on branch content, and CI re-runs
  the same guard with `fetch-depth: 0` on every PR.

## What's Next / Blockers

No blockers. Highest-value follow-ups, in order:

1. **Schema-derived test fixtures (Zod default factories)** — the largest remaining piece of
   class D. Would structurally prevent "adding a required field reds every fixture"
   (regressions #4, #7), which the registry ID check does not address.
2. **Class E collision radar** — extend `check:aggregate-row-ownership` to flag, at PR-open,
   any other in-flight PR touching the same aggregate file/row. Deferred here as its own
   multi-apple change; it needs cross-PR state.
3. **Class F structural image metrics** — alpha-aware background classification and
   cross-frame identity hashing, run corpus-wide alongside `anti-lattice`.
4. **A `forEachSafe` wrapper** for the automation trees, making the class-B deadlock
   unrepresentable rather than merely detectable. The lint rule is the low-risk first step.
5. **Recall gap in the lint rule** — it does not see a rethrow in a helper _called from_ a
   loop, nor a batch expressed as `Promise.all(items.map(...))`. Revisit if a deadlock
   recurs through either shape.
6. **Expiry-bump detection in `check:allowlist-expiry`** — compare time-bounded entries
   against the base revision and reject an increased `expiresOn` whose `reason` is
   unchanged (the npm-audit / Knip guards already do this base-ref comparison). Raised by
   the code-review stage; deferred because it needs base-revision plumbing this checker
   does not have. Recorded in ADR 0082 Risks.
7. **Process control from the retrospective that is not yet mechanized**: every
   human/shepherd/CI-god intervention should close with either a deterministic check or a
   dated accepted-risk entry. Roughly a third of the 20 closed with neither.

## Retrospective

### Lessons Learned

- **`npm ci` fails in this sandbox by default.** `package-lock.json` pins
  `ms-feed-12.pkgs.visualstudio.com`, which does not resolve here. `registry.npmjs.org`
  does. Working command: `npm ci --replace-registry-host=npmjs` (427 packages, ~19 s; does
  **not** modify the lockfile — `git status` on `package-lock.json` stays clean).
- **A guard's first run on a mature repo is a survey, not a pass/fail.** Both new
  corpus-wide checks found real pre-existing defects immediately. Budget for that: the
  correct response is to fix what is found, and the temptation to allowlist it instead is
  the exact failure the guard was written to prevent.
- **Narrow the guard _before_ wiring it at `error` level.** Running the un-narrowed rule
  first and reading all 24 hits is what revealed that 23 were legitimate — that survey step
  is what produced the loop-scope insight, and it cost minutes.
- **`eslint-disable-next-line` must be the immediately preceding line.** A multi-line
  explanatory comment placed _after_ the directive silently detaches it; ESLint then reports
  both the original error and an "unused disable directive" warning. Put the prose above and
  the directive last.
- **ESLint only assigns `parent` to nodes it has already entered**, so downward
  parent-pointer walking from a `CatchClause` is unsafe. Use
  `sourceCode.getAncestors(node)` for the upward walk and an explicit visitor-keys traversal
  for the downward one.

### Mistakes Made

- **Ran four background agents in one shared working tree. This was the single biggest
  error of the session and it caused two separate near-catastrophes.** (a) Concurrent
  `npm ci` invocations corrupted `node_modules` with `ENOTEMPTY`. (b) One agent ran
  `sync:main`/preflight, which stashed every tracked edit and reset `HEAD` — wiping the
  entire working tree mid-session. Recovery was `git reflog` → `git stash list` →
  `git stash pop`. **Early signal:** any agent reporting that a file it just wrote has
  vanished, or an unexpected `HEAD` change. **Rule for next time:** parallel agents get
  disjoint _files_, but that is not sufficient — they must also be explicitly forbidden from
  `npm ci/install`, `sync:main`, `preflight.sh`, and every git state-changing command, since
  those are tree-global side effects that no file partition protects against. Better still:
  give parallel agents separate worktrees.
- **Initially believed the `reconcile.mjs` rethrow was an unambiguous bug and started
  "fixing" it before reading the tests.** A source-string test asserted the rethrow was
  _required_, with a stated rationale. The fix was only correct once it honored that
  rationale by another mechanism. **Early signal:** when a bug looks too obvious to have
  survived, grep the test suite for an assertion pinning the current behavior _first_.
- **Wrote the first `eslint-disable` with the directive on the first line of a multi-line
  comment**, which detached it and produced a confusing double report. Cost one extra
  lint cycle.

### Opportunities for Future Improvement

- **Parallel agents need worktree isolation, not just file partitioning.** The session's
  worst failures were both tree-global side effects. A `scripts/agent/` helper that
  provisions a throwaway worktree per background agent would remove this entire class.
- **The `KNOWN_ORPHAN_SHARDS` pattern is a trap worth linting.** An agent authoring a new
  guard naturally adds a tolerance list for pre-existing violations so its own tests go
  green. That is precisely how a guard is born already-defanged. Consider requiring any such
  list to be governed by `check:allowlist-expiry` (reason + expiry) from the moment it is
  created — which this session's own control would have caught, had the list been named
  recognizably.
- **A guard's own prose can trip the guard.** Adding an illustrative
  `const HIDDEN_ALLOWLIST = []; export { … }` example to a comment in
  `allowlist-expiry-lib.ts` made `check:allowlist-expiry` report itself. Discovery is
  text-based by design (cheap, no parser), so example code in comments inside a scanned
  root must be written so it does not match the very pattern being scanned for.
- **`check:extensions` should assert a loaded-_count_, not just absence of bare imports.**
  The class-G receipt is "extension silently not loading"; the current check verifies a
  necessary but not sufficient condition.
- **Track intervention counts per root-cause class** in `docs/knowledge/metrics/velocity`,
  so the payoff of each control here becomes measurable rather than asserted. Without it
  there is no way to tell in three months whether classes A–D actually declined.
