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
  `getEffectiveTelegraphMs` (`mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`,
  250ms production/headless default), `startEnemyProjectileTelegraph`,
  `cancelEnemyProjectileTelegraph`, `isEnemyProjectileTelegraphActive/Ready`.
- `enemyAISystem.ts`: fire logic now goes through a telegraph state machine —
  start telegraph → hold (movement frozen, aim locked) → fire from the locked
  origin/direction once ready. Cancelled from every early-exit branch (lost
  player/detection/attack-range, and now also the "player entity gone"
  branch — see review-found fix below).
- `PhaserBridge.ts`: renders a visible cue (red fill, drawn from the locked
  origin/direction) while a telegraph is active; hidden (not destroyed) once
  it clears.
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
recreated, hidden while outside FOV, and hidden for a shooter killed this
same frame) is additionally covered by 4 new deterministic
`tests/unit/phaser-bridge.test.ts` assertions, since this sandboxed
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
- The Windows Git-Bash `local-scope.sh`/`detect-art-only.sh` quirk (see
  Lessons Learned) would benefit from a real fix in a dedicated
  infra/tooling session — out of scope here since it's pre-existing and
  unrelated to this feature.

## Retrospective

### Lessons Learned

- **`VERIFY_FULL=1 npm run verify` cannot complete locally on this Windows
  Git-Bash environment**: it aborts (via `set -e`) at the unit-test step on
  45 pre-existing exit-127 ("command not found") failures in
  `tests/unit/detect-change-scope.test.ts` / `tests/unit/local-scope.test.ts`
  — the scripts they shell out to (`detect-art-only.sh`, `local-scope.sh`)
  aren't resolving under Windows Git-Bash. Confirmed via `git stash` these
  failures are pre-existing on clean `main`, unrelated to this feature. This
  is the same family as the already-documented `lab-gate-check.sh` slowness
  quirk in AGENTS.md's "Known Environment Quirks" — worth adding this one
  alongside it in a future docs-only session. Because full local `verify`
  never reaches the headless Floor-1 (`VERIFY_FULL`) steps here, the direct
  seed42 headless CLI repro (run manually, both at 250ms and 0ms, plus the
  git-stash byte-for-byte comparison) is what actually validated the
  real-pipeline behavior for this change.
- **Git-stash legacy-parity proof is a strong, reusable technique**: for any
  "value X must reproduce exact legacy behavior" requirement, `git stash push
-u` → run the identical headless CLI invocation on the clean pre-feature
  tree → diff output → `git stash pop` gives a much stronger guarantee than
  "the code path looks like it does nothing" — it proves byte-for-byte
  output identity on the real pipeline.
- **No screenshot capability for Phaser canvas in this sandboxed
  environment's Playwright/chrome-devtools tools**: pivoted to writing 2
  deterministic `tests/unit/phaser-bridge.test.ts` assertions (cue created +
  visible while telegraphing; same object hidden, not recreated, once
  cleared) instead of a manual visual pass. This matches the repo's own
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
  that the fireball's `projectileSpeed` used in the AI's dodge math was
  `0.5` (ft/frame). When designing the muzzle-offset regression test I
  grepped `weapons.json` directly and found it's actually `4.0` — a very
  different per-frame speed. Recomputing the regression scenario's geometry
  around the real value (and choosing a player x-position exactly equal to
  `MUZZLE_OFFSET` to keep `impactFramesAfterSpawn` at a clean `0` in the
  fixed case) avoided a test that would have been silently wrong. Lesson:
  always re-derive numeric test fixtures from the actual constant/data-file
  values at the point of writing the test, never from an earlier segment's
  paraphrase, however confident it sounded.
- Spent time initially trying to fight the `npm run review:ledger -- stage
<path> <stage> --json '{...}'` CLI through PowerShell's quote-stripping
  before remembering the ledger is just a plain JSON file — directly editing
  it with the `edit` tool and then running `... validate` was far simpler
  and less error-prone than the documented `ConvertTo-Json`/`node -e` merge
  workaround from earlier segments. Prefer direct-edit-then-validate for
  ledger stage updates going forward when the file already exists.

### Opportunities for Future Improvement

- Add the Windows Git-Bash `local-scope.sh`/`detect-art-only.sh` exit-127
  quirk to AGENTS.md's "Known Environment Quirks" section (docs-only,
  separate session) so it stops being independently rediscovered.
- The muzzle-offset constant (`ENEMY_PROJECTILE.MUZZLE_OFFSET`) and the
  fireball weapon def's `projectileSpeed` live in two different data files
  (`tuning.json` vs `weapons.json`) and are combined only inside
  `bt-ai-provider.ts`'s dodge math and `enemyAISystem.ts`'s fire logic
  separately — a shared helper that computes "real fire-time spawn point
  given locked origin/dir" (used by both call sites) would make a future
  regression like this structurally impossible rather than relying on
  review to catch a copy-pasted-but-diverged formula.
