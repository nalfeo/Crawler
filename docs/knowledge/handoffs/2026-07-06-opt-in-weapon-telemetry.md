# Session Handoff: Opt-in per-run weapon telemetry (accuracy + multi-hit)

## Date

2026-07-06

## Persona

Producer

## Systems touched

weapons, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (exact — clean cherry-pick, review surfaced 2 real bugs that were bounded fixes)

## What Was Done

Shepherded an already-committed feature (commit `8a6401dc`) onto a **clean branch off `main`**, deliberately isolated from the gate-failing `farmPullWeight`/`bt-ai-tuning.ts` balance regression that keeps its source branch's PR (#811) in Draft.

- Cherry-picked ONLY `8a6401dc` (17 files, +730/-10) → clean, no conflicts. Confirmed no `bt-ai-tuning`/`farmPull` bytes came along.
- The feature: a data-only per-weapon-cast telemetry accumulator (`src/core/weapon-telemetry.ts`, interfaces in `src/shared/weapon-telemetry-types.ts`) that tracks activations, connecting/multi-hit swings, and accuracy misses. **OFF by default** — every hook is gated on `world.weaponTelemetry` being defined; `DEFAULT_CONFIG.recordWeaponTelemetry = false`. Opt-in via headless `--weapon-telemetry` flag or recorder option.
- **Zero-delta proven** in the real headless artifact: collision-pair-parity byte-identical with vs without the telemetry files, and `VERIFY_FULL=1 npm run verify` Floor-1 headless gate **passed** on the clean main base. Observed in the headless runner — before: no `weaponTelemetry` in `RunStats`; after (opt-in): populated summary, and with the flag OFF the run is byte-identical.
- Review harness (3🍎): separate-model plan review (gpt-5.4) + code-review loop (claude-sonnet-4.6, 2 rounds to clean). Fixed 2 real bugs it surfaced (see Key Decisions). Ledger: `docs/knowledge/review-ledgers/2026-07-06-opt-in-weapon-telemetry.review-ledger.json`.

## Key Decisions Made

- **Pruning leak (fixed):** projectile activation tags were only pruned in `damageSystem.destroyEntity`. `projectileCleanupSystem` (4 sites) and `returningProjectileSystem` (2 sites) despawn via `clearEntityStores + removeEntity` without pruning → `entityActivation` map leak + recycled-eid misattribution risk. Added `pruneAttackEntity` before `removeEntity` at all 6 sites. No-op when disabled ⇒ preserves zero-delta. (Invariant 4.)
- **Recorder scoping (fixed):** `player-session-recorder.ts` now captures `recordWeaponTelemetry` at construction and gates BOTH the collector install AND the `getStats()` exposure on it — a recorder that didn't opt in returns `{}` regardless of what's on `world.weaponTelemetry`.
- **Beam/trap under-reporting (documented, not code-fixed):** `dispatchAttack` counts a swing for every weapon type, but only melee/projectile spawners tag entities. `spawnBeam` and traps are untagged, so beam/trap-heavy runs under-report accuracy. Chose to preserve invariant 2 (enemy attacks must stay untagged; expanding tagging risks mis-tagging) and document the limitation in the module doc rather than widen scope. Floor-1 weapon sweep uses only melee/ranged, so the win-rate gate is unaffected.
- **New shared type file:** interfaces live in `src/shared/weapon-telemetry-types.ts` (not core) because `src/shared` must not import `src/core`, and `SessionRecorderStats` (shared) needs the summary type. `src/core/weapon-telemetry.ts` imports + re-exports them.

## What's Next / Blockers

- PR opened against `main`; auto-merge armed with `--squash`. Next session: confirm final merge state if not yet MERGED, and clear any late review threads (reply `✅ Addressed in <sha>`; owner-resolve `copilot-pull-request-reviewer` threads via GraphQL `resolveReviewThread`).
- Future: if beam/trap accuracy telemetry is ever needed, tag `spawnBeam` + trap spawns behind the same open-activation gate (careful not to tag enemy-sourced beams/traps).
- Do NOT reuse PR #811 or bring its `farmPullWeight` change — it stays Draft until its balance regression is resolved separately.

## Retrospective

### Lessons Learned

- **Off-by-default features are the cleanest way to isolate a change from a gate.** Because every hook no-ops when `world.weaponTelemetry` is undefined, I could prove byte-identical collision-pair-parity and pass the Floor-1 headless gate without touching any golden or balance value — the ideal shape for a feature that must not perturb sim determinism.
- **The pruning leak was invisible to the happy path.** All original 20 tests passed; the leak only manifested on the `projectileCleanupSystem`/`returningProjectileSystem` despawn routes, which no telemetry test exercised. Reviewers caught it by reasoning about despawn paths, not by a failing test — a good argument for the plan-review + code-review loop on anything touching entity lifecycle.
- **`git cherry-pick` of a single commit is far safer than reusing a diverged feature branch** when that branch carries unrelated failing changes. The commit was ~38 commits deep but cherry-picked cleanly onto current main.

### Mistakes Made

- Initially considered code-fixing the beam/trap gap by tagging `spawnBeam`; realized mid-analysis that indiscriminate tagging would break invariant 2 (enemy attacks must not be tagged) and expand scope beyond the isolated feature. Early signal: any fix that requires tagging a NEW spawner should be checked against "could this tag an enemy-sourced entity?" before writing code.
- Spent a cycle on a `verify:fast` failure (`floor2-scenario-initialization.test.ts` timeout) that turned out to be environmental (Windows parallel CPU contention; passes 7/7 in isolation, fine on CI/Linux). Early signal: a 30s timeout on a test with no shared code path to the change is almost always contention, not a regression — check isolation first before assuming causation.

### Opportunities for Future Improvement

- A deterministic headless assertion that opt-in telemetry is byte-identical to opt-out (beyond the manual collision-pair-parity check) would turn the zero-delta guarantee into a permanent regression guard.
- The pruning-leak class (activation tag not pruned on a despawn path) could be caught structurally: a lint/health check that every site calling `removeEntity` on a potentially-tagged attack entity also calls `pruneAttackEntity`.
- `lab-gate-check.sh` remains pathologically slow (~50s/system) on Windows Git Bash — run on CI/WSL. (Known quirk, re-confirmed.)
