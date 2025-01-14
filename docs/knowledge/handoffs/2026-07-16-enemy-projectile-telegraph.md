# Session Handoff: Enemy projectile telegraph (aim-lock + visual cue + AI dodge)

## Date

2026-07-16

## Persona

Producer (single-session implementation; no sub-slice delegation was needed — the
locked-origin/direction architecture kept combat contract, render cue, and AI
response coherent as one integrated change).

## Systems touched

ai-behavior-tree, ai-combat-balance, weapons, enemies

## Apples

5🍎 estimated → 5🍎 actual (exact). Full JSON: `docs/knowledge/metrics/apples/2026-07-16-enemy-projectile-telegraph.json`.

## What Was Done

Every hostile projectile shot (including bosses and rapid-fire follow-ups) now
enters a visible telegraph state before firing. The aim vector (origin +
direction) locks the instant the telegraph begins and stays immutable through
spawn — the same locked state feeds the render cue, the real fire logic, and
the AI's dodge reasoning, so none of the three can diverge.

- New `src/core/systems/enemyTelegraph.ts`: single source of truth —
  `getEffectiveTelegraphMs` (a **validating** fallback chain —
  `mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`,
  250ms production/headless default — where any candidate that is negative,
  non-finite, Float32-overflowing, or would silently underflow to `0` in the
  Float32-backed store is treated as absent and falls through to the next
  level rather than being used verbatim), `startEnemyProjectileTelegraph`,
  `cancelEnemyProjectileTelegraph`, `isEnemyProjectileTelegraphActive/Ready`.
- `enemyAISystem.ts`: fire logic now goes through a telegraph state machine —
  start telegraph → hold (movement frozen, aim locked) → fire from the locked
  origin/direction once ready. Cancelled from every early-exit branch (lost
  player/detection/attack-range, and now also the "player entity gone"
  branch — see review-found fix below).
- `PhaserBridge.ts`: renders a visible cue (red fill, drawn from the locked
  origin/direction) while a telegraph is active; hidden (not destroyed) once
  it clears. Also draws for one rendered frame via the sticky
  `telegraphWasActiveThisFrame` flag (added post-merge with PR #1200) when a
  telegraph starts and completes entirely within a single multi-step
  catch-up batch (e.g. the AI-runner's 16× playback), so the cue is never
  invisibly skipped just because `telegraphActive` already cleared before
  the next rendered frame.
- `bt-ai-provider.ts`: BehaviorTreeAI reads the same public `EnemyBehavior`
  store fields (no privileged prediction) to (a) evaluate ranged danger using
  the enemy's _actual_ attack range and (b) dodge the locked trajectory of a
  telegraphing shot via a virtual-projectile impact-time calculation that
  competes with real in-flight projectiles for "closest threat first"
  priority.
- CLI: new `--enemy-telegraph-ms <n>` flag on the headless runner; production
  and headless defaults are both 250ms. `0` (world- or per-mob-level)
  reproduces today's legacy behavior exactly: no cue, no delay, no
  locked-trajectory dodge.
- ADR: `docs/knowledge/adr/2026-07-16-enemy-projectile-telegraph.md`.

**Runtime/real-artifact observation** (rule #9/#10): observed via the
production headless pipeline — ran the seed42 Floor 2 baseball-bat repro
at the 250ms default (telegraph cue timing visible in RunStats-adjacent
frame traces) and at 0ms. A rigorous `git stash` comparison against
pre-feature `main` proved the 0ms run's output is **byte-for-byte identical**
to legacy behavior for the same seed/floor/weapon/frame-count — confirming
the "0 = exact legacy parity" requirement holds in the real pipeline, not
just in unit tests. Render-cue behavior (create-once/show/hide, never
recreated, hidden while outside FOV, hidden for a shooter killed this
same frame, and destroyed if its EID is recycled mid-simulation) is
additionally covered by 7 new deterministic
`tests/unit/phaser-bridge.test.ts` assertions (including a sticky-flag
16×-catch-up-batch render regression added post-merge with PR #1200),
since this sandboxed
environment's Playwright/chrome-devtools tools had no screenshot capability
for Phaser canvas content — the repo's documented deterministic-check
convention (rule #9) was used instead of a manual visual pass.

**Two real bugs were found and fixed by the multi-model code review** (see
Key Decisions below) before this PR: a telegraph-cancellation gap on the
"player entity disappeared" branch, and a muzzle-offset drift between the
AI's virtual-projectile dodge math and the real fire-time spawn point. Both
have dedicated regression tests that fail if either fix is reverted.

## Key Decisions Made

- **Locked-origin/direction architecture**: `telegraphOriginX/Y` and
  `telegraphDirX/Y` are captured ONCE at telegraph start and read verbatim by
  render, AI dodge math, and the real fire-time spawn. This was the outcome
  of a 4-round adversarial plan review (gpt-5.4) and is what makes rendering
  and AI dodge provably consistent with each other and with what actually
  fires — even if the enemy is later displaced by an unrelated system
  (separation/knockback/unstuck).
- **Muzzle-offset fix** (found independently by gpt-5.3-codex AND
  gemini-3.1-pro-preview in a 4-way multi-model review fan-out, confirmed
  valid by a gpt-5.4 xhigh adjudicator): `fireEnemyProjectileFrom` spawns the
  real projectile at `origin + dir * ENEMY_PROJECTILE.MUZZLE_OFFSET` (1.5ft),
  but the AI's virtual-projectile dodge math was using the raw locked origin
  — a systematic drift between what the AI dodges and where the shot
  actually spawns. Fixed by applying the same muzzle offset before computing
  the AI's relative position. The render cue was deliberately left as-is
  (adjudicator-confirmed correct): it intentionally shows the enemy's locked
  _body_ position, not the muzzle point.
- **No-player-branch cancellation gap** (found by gpt-5.3-codex, confirmed by
  the adjudicator): `enemyAISystem`'s `playerEid === undefined` early-return
  was the only early-exit branch that didn't cancel an in-progress telegraph.
  Fixed by adding the cancellation call inside that branch's per-enemy loop.
- **`createTestWorld()` defaults `world.enemyTelegraphMs = 0`** to preserve
  byte-for-byte legacy parity for the entire pre-existing test suite; the
  multi-model review explicitly confirmed this correctly leaves all 3 new
  code paths (0ms / nonzero-start / nonzero-fire) exercised only by the new,
  dedicated telegraph test files — no masking of bugs behind the default.

## What's Next / Blockers

None blocking. Follow-up ideas (not required by the approved spec):

- Consider surfacing telegraph state in the ai-runner-lab overlay's debug HUD
  more prominently (it's wired but minimal) if a future session wants richer
  lab-side visualization.

## Retrospective

### Lessons Learned

- \*\*`tests/unit/local-scope.test.ts` / `tests/unit/detect-change-scope.test.ts`
  failed (45 tests) under this sandbox's `bash` — root-caused and fixed as a
  drive-by per AGENTS.md rule #7 (no "pre-existing/out of scope" deferral)
  when a review thread correctly flagged an earlier draft of this handoff for
  documenting the failures as out-of-scope instead of fixing them. Two
  distinct real bugs, not one:
  1. Both tests build `SCRIPT` via `path.resolve(...)` (a Windows-style
     `C:\Users\...` absolute path) and pass it as a `spawnSync('bash', [SCRIPT])`
     argv element — no shell, so none of bash's usual path-translation magic
     fires. This sandbox's `bash` on `PATH` is actually the WSL interop shim
     (`C:\Windows\System32\bash.exe`, genuine `x86_64-pc-linux-gnu`), which
     cannot resolve a raw drive-letter path at all. Fixed with a new
     `tests/helpers/bash-script-path.ts::toBashScriptPath()` that converts to
     the WSL-mount form (`/mnt/c/Users/...`) when needed, detected once via a
     `/mnt/c` probe, and is a no-op on non-Windows/non-WSL bash.
  2. Separately, WSL's interop layer does **not** forward the parent Windows
     process's environment variables into the Linux session unless they're
     named in the `WSLENV` allow-list — so `detect-change-scope.test.ts`'s
     `SCOPE_FILES_OVERRIDE`/`GITHUB_OUTPUT`/`PACKAGE_JSON_GAMEPLAY_SAFE_OVERRIDE`
     env overrides were silently dropped, degrading every case to the
     empty-changeset fail-safe. Fixed with `bash-script-path.ts::bashEnv()`,
     which extends `WSLENV` with the names of whatever custom env vars a
     caller passes (preserving any pre-existing `WSLENV`); inert on non-WSL
     bash.
  3. A related but independent third issue in `local-scope.test.ts`: a
     just-exited WSL `bash.exe` child leaves its working directory
     transiently locked from Windows' point of view (observed up to ~3s),
     racing the test's `afterEach` cleanup into `EBUSY`. `fs.rmSync`'s own
     `maxRetries`/`retryDelay` do **not** cover this — they only retry errors
     hit while walking the tree, not a busy top-level `rmdir` — so fixed with
     a real async wait-and-retry loop (`rmDirWithRetry`, 15 attempts / 300ms).
     All 45 previously-failing tests pass now; confirmed via a full
     `npx vitest run --project unit` pass (330 files, 4035 tests) with no
     regressions elsewhere.
- **`VERIFY_FULL=1 npm run verify` was not re-run to completion locally** in
  this sandbox (the headless Floor-1 step alone takes ~10 minutes real-world,
  and this session already validated the sim behavior directly — see below).
  The specific blocker that previously stopped local `verify` from reaching
  that step at all — the 45 `local-scope.test.ts`/`detect-change-scope.test.ts`
  failures aborting the unit-test step under `set -e` — is fixed (see above),
  so a future session attempting `VERIFY_FULL` here should no longer hit it.
  Because this session didn't run the headless Floor-1 step through `verify`,
  the direct seed42 headless CLI repro (run manually, both at 250ms and 0ms,
  plus the git-stash byte-for-byte comparison) is what actually validated the
  real-pipeline behavior for this change.
- **Git-stash legacy-parity proof is a strong, reusable technique**: for any
  "value X must reproduce exact legacy behavior" requirement, `git stash push
-u` → run the identical headless CLI invocation on the clean pre-feature
  tree → diff output → `git stash pop` gives a much stronger guarantee than
  "the code path looks like it does nothing" — it proves byte-for-byte
  output identity on the real pipeline.
- **No screenshot capability for Phaser canvas in this sandboxed
  environment's Playwright/chrome-devtools tools**: pivoted to writing 7
  deterministic `tests/unit/phaser-bridge.test.ts` assertions (cue created +
  visible while telegraphing, pinned to the locked origin even after the
  shooter drifts; same object hidden, not recreated, once cleared; hidden
  outside FOV; hidden for a shooter killed this frame; destroyed if its EID
  is recycled mid-simulation; urgency-pulse phased on the telegraph's own
  elapsed time rather than the absolute render clock; and — added post-merge
  with PR #1200 — a sticky-flag render regression covering a telegraph that
  starts and completes entirely within one 16×-speed AI-runner catch-up
  batch)
  instead of a manual visual pass. This matches the repo's own
  stated preference (rule #9) for deterministic checks over ad hoc visual
  QA, so treat "no screenshot tool" as a nudge toward the better default,
  not just a workaround.
- **Multi-model code review earned its keep here**: a single-model
  (sonnet) pass over the full diff explicitly checked all 9 contract points
  and found nothing. Two independent other models (codex, gemini) both
  caught the same real muzzle-offset drift bug that sonnet missed. This is
  concrete evidence for why the >3🍎 policy requires BOTH a code_review
  stage AND a separate multi_model_review stage rather than treating one
  clean single-model pass as sufficient.
- System Node on this box is v18.20.6, too old for vitest/rolldown; every
  fresh PowerShell session needs
  `$env:PATH = "$env:TEMP\node22\node-v22.14.0-win-x64;$env:PATH"` prepended
  before any npm/vitest/tsx command.
- `npm run typecheck:src` only checks `tsconfig.src.json` and excludes
  `tests/` — always run the full `npm run typecheck` before considering test
  files done; it caught a `number|undefined` error that `typecheck:src`
  missed.

### Mistakes Made

- Initially trusted a stale, unverified assumption from an earlier segment
  that the fireball's `projectileSpeed` used in the AI's dodge math was `4`
  (ft/frame), carried over from a quick grep of the raw
  `src/shared/data/weapons.json` fixture. Neither the real fire path
  (`enemyAISystem.ts`) nor the AI's dodge math actually reads that JSON file
  at runtime — both call `getWeaponDef('fireball')` (`src/shared/weaponDefs.ts`),
  whose hardcoded `WEAPON_DEFS` entry is the true runtime source of truth and
  is `0.5` ft/frame, not `4`. This invalidated an entire round's worth of test
  scaffolding built on the wrong number before it was caught (a debug script
  that printed `fireballDef` directly from `getWeaponDef` settled it). Lesson:
  always re-derive numeric test fixtures from the actual **runtime accessor**
  a system calls (`getWeaponDef(...)`, not a raw JSON data file that may be
  unused/stale), and verify by printing the value the production code path
  actually reads, never from an earlier segment's paraphrase or a grep of a
  data file whose contents aren't provably wired to that code path.
- Spent time initially trying to fight the `npm run review:ledger -- stage
<path> <stage> --json '{...}'` CLI through PowerShell's quote-stripping
  before remembering the ledger is just a plain JSON file — directly editing
  it with the `edit` tool and then running `... validate` was far simpler
  and less error-prone than the documented `ConvertTo-Json`/`node -e` merge
  workaround from earlier segments. Prefer direct-edit-then-validate for
  ledger stage updates going forward when the file already exists.

### Opportunities for Future Improvement

- The muzzle-offset constant (`ENEMY_PROJECTILE.MUZZLE_OFFSET`, from
  `tuning.json`) and the fireball weapon def's `projectileSpeed` (from the
  runtime `getWeaponDef('fireball')` accessor in `src/shared/weaponDefs.ts`
  — NOT the stale, unused `src/shared/data/weapons.json` raw fixture) are
  combined only inside `bt-ai-provider.ts`'s dodge math and
  `enemyAISystem.ts`'s fire logic separately — a shared helper that computes
  "real fire-time spawn point given locked origin/dir" (used by both call
  sites) would make a future regression like this structurally impossible
  rather than relying on review to catch a copy-pasted-but-diverged formula.
  Separately, `src/shared/data/weapons.json` appears to be dead/unused data
  now that `weaponDefs.ts` hardcodes its own defs — worth a follow-up
  investigation (out of scope here) into whether it should be deleted or
  wired back up as the actual source of truth.

## Balance validation: 250ms telegraph default vs. pre-PR baseline

The review harness flagged the new 250ms production/headless telegraph
default as a hostile-cadence/AI-behavior change requiring a broad win-rate
seed sweep (only one seed-42 smoke run had been reported). Per AGENTS.md's
"broad sweeps (>10 runs) use GitHub infrastructure" rule, this was run via
two GitHub-Actions `weapon-sweep.yml` `workflow_dispatch` runs (not local
compute), comparing pre-PR `main` (no telegraph; instant fire) against this
PR's branch (250ms telegraph default) across all 6 Floor-1 starter weapons ×
seeds 1-15 (90 runs each side).

**Re-validated on the final diff (round-11 shepherding)**: the originally
recorded sweep ran against `0a0435b3`, which predates the dodge range-gate
clamp, the round-7 dodge-math off-by-one fix, and `main`'s since-merged
legacy-Floor1-deaths fix (#1197) — all of which can plausibly move AI
outcomes (`copilot-pull-request-reviewer` finding). Re-ran the identical
methodology against the current heads of both `main` (`b61c1bc7`, now
including #1197) and this PR's branch (`104926c1`, the final round-10
commit):

- `main` baseline re-run: <https://github.com/nalfeo/Crawler/actions/runs/29507839303>
- PR-branch re-run (250ms telegraph): <https://github.com/nalfeo/Crawler/actions/runs/29507847482>

| weapon         | runs | main win% | PR win% (250ms) | delta  |
| -------------- | ---- | --------- | --------------- | ------ |
| baseball-bat   | 15   | 100.0%    | 100.0%          | +0.0%  |
| bow            | 15   | 100.0%    | 100.0%          | +0.0%  |
| fireball       | 15   | 100.0%    | 100.0%          | +0.0%  |
| pistol         | 15   | 100.0%    | 100.0%          | +0.0%  |
| sword          | 15   | 93.3%     | 86.7%           | -6.7%  |
| throwing-knife | 15   | 80.0%     | 66.7%           | -13.3% |
| **OVERALL**    | 90   | **95.6%** | **92.2%**       | -3.4%  |

Both the pre-PR baseline and the post-PR (telegraph-enabled) overall win
rate stay comfortably at/above the repo's Floor-1 90%+ win-rate gate
(AGENTS.md rule 12), so this is not the "materially less than 90%" signal
that rule flags as a likely AI-runner bug or extreme regression — no code
change was made in response to this sweep, per the explicit hard constraint
not to retune damage/cadence/spawn-rate/player-stat values or bend gameplay
to chase a higher rate on this sweep. The largest per-weapon deltas
(throwing-knife -13.3pp, sword -6.7pp) are consistent with those being the
two weapons with the least reach/mobility against a ranged attacker that now
telegraphs for 250ms before firing (rather than firing instantly on
detection): melee weapons must still close the distance during that window,
so they carry the exposure a beat longer than before. This is the observed
effect of adding the telegraph delay itself (not a change to the enemy's aim
or damage), which is the intended effect of the feature, not a bug. The
re-run confirms the range-gate clamp, round-7 dodge-math fix, round-9
MainGameScene poll-ordering fix (browser-only — does not affect this
headless sweep at all), round-10 Float32-guard fix, and `main`'s
legacy-Floor1-deaths fix did not materially shift these numbers (the
overall delta moved by 0.1pp, within rounding noise for 90 runs/side).
Recorded here as the sweep artifact this thread requested; raw JSON
available via the four workflow runs' uploaded artifacts
(`weapon-sweep-<weapon>.json`, 30-day retention). The original
(now-superseded) sweep run links remain in this section's git history for
provenance.
