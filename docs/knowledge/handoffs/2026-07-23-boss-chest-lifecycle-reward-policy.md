# Boss chest lifecycle + boss reward-policy (Floor 2 equipment epic)

## Systems touched

floor2-equipment, boss-encounters, save-load, labs

## Summary

Implements the Floor 2 "second equipment source" slice of the equipment
epic: Floor 2 boss defeats deterministically resolve and persist an
equipment reward bundle at the exact boss-defeat/chest-creation boundary,
expose an explicit chest lifecycle for later UX/AI consumption, and route
all opening/claiming through the shared exact-once atomic claim path used
elsewhere in the equipment economy. Floor 1 boss loot remains equipment-free
(hard gate, enforced by tests). Built on merged PR #1810 (resolved reward
bundles, squash `9be0328ec740f47e19c460dca5cb863bd1632d56`) and current
equipment definitions.

**Lifecycle states** (canonical, `src/core/systems/bossChestRewards.ts`):
`available` → `opening`(transient) → `revealed` → `claimed`, plus a
fail-closed rejection (`invalidTransition`) for any out-of-order call (e.g.
acknowledge before open). Transitions are deterministic and idempotent:
opening an already-`revealed`/`claimed` chest returns
`{ ok: true, alreadyClaimed: true, ... }` without re-granting or
re-rolling; it never re-invokes generation.

**Reward-policy boundary**: `spawnBossChestForDefeatedBoss`
(`src/game/boss-chest-resolver.ts`) is the single call site that resolves
a deterministic equipment reward bundle (via the existing generated-equipment
registry from PR #1810) and creates the chest record, at boss-defeat time
— not at open time. `openBossChest`/`acknowledgeBossChestReveal` only
transition state and grant the already-resolved bundle through the shared
atomic claim path (`claimGeneratedEquipmentRewardBundle`); they never call
into generation.

**Floor 1 exclusion**: Floor 1 boss defeats never call
`spawnBossChestForDefeatedBoss`; Floor 1 boss loot tables were audited and
confirmed to contain zero equipment entries (`tests/unit/loot-tables.test.ts`
extended to assert this).

**Save/load carryover**: `src/game/playerCarryover.ts` persists
`bossChests` (state + resolved bundle references) across floor
transitions/save-load. This surfaced and fixed **4 real, in-scope
pre-existing gaps** in carryover validation during multi-model review (all
touching code this branch modified):

1. Missing default for `bossChests` when restoring pre-existing v1
   snapshots (would throw/undefined on legacy saves).
2. Explicit `null` for `bossChests` wasn't treated the same as "missing"
   (fail-closed gap).
3. Non-string `familyId` / non-numeric `createdAtMs` on a persisted chest
   record weren't guarded (would silently persist malformed state).
4. Three other generated-array fields on the snapshot lacked the same
   default/null-element guards as `bossChests` once the pattern was
   identified — normalized all four for consistency, plus null-array-element
   guards.

24 tests in `tests/unit/player-carryover.test.ts` (7 new this session) cover
all of the above.

**Duplicate-open/claim idempotency & fail-closed handling**: covered by
unit (`tests/unit/bossChestRewards.test.ts`), integration
(`tests/integration/boss-chest-lifecycle.integration.test.ts`), and headless
(`tests/headless/boss-chest-lifecycle.test.ts`) suites, plus the new
`bosschestrewards-lab` for live/manual observation.

**Wiring**: `bossChestRewards` core-systems module and
`boss-chest-resolver` game-layer module are wired into
`src/game/floor2Scenario.ts` (both the normal boss-defeat path and the
victory-sweep latch path — see commit `d41a5eb24`, a real headless-observed
bug found before the reward-policy fix landed: boss chests weren't spawned
when a boss was defeated via the victory-sweep latch, only the primary
defeat path). `npm run check:wired-systems` passes.

## Review harness (5🍎 tier — full ledger)

`docs/knowledge/review-ledgers/2026-07-23-boss-chest-lifecycle-reward-policy.review-ledger.json`
— validates as a complete 5-apple ledger:

- **Adversarial plan review**: 7/7 concerns resolved, `adversarial: true`,
  3 alternatives considered.
- **Code-review loop**: round 1 found 1 High bug (fixed), round 2 clean.
- **Multi-model review**: 5 rounds (codex + gemini, some rounds also
  sonnet/security), each round found real bugs in
  `playerCarryover.ts` save/load validation — all fixed (see the 4 fixes
  above, commits `bcc5d9991`, `c9944298f`, `5dedc9975`, `d06cf274b`).
  Round 5 (explicitly prompted to check every other array field on the
  snapshot) surfaced 7 more findings, but `git diff` against the merge-base
  confirmed all 7 touch code paths **never modified by this branch**
  (pre-existing gaps in achievements/inventory/skills/ability-grant code
  unrelated to boss chests) — filed as follow-up issue #1821 rather than
  scope-creeping this PR.
  A retroactive adjudicator (gpt-5.4, xhigh reasoning) independently
  re-verified all 5 rounds' findings/fixes and round 5's out-of-scope
  determination against current source + a fresh test run: **CLEAN**.

## Lab

`src/labs/bosschestrewards-lab/index.ts` — new dedicated lab (no existing
lab exercised this flow; `SHARED_LAB_MAP` mapping to `floor2-settlement-lab`
or `equipment-lab` would have been a worse fit). Creates a real Floor 2
world with the equipment economy enabled, spawns two lab boss chests via
`spawnBossChestForDefeatedBoss`, and exposes Open/Acknowledge per-chest
buttons plus two demo buttons (open-twice idempotency, acknowledge-before-open
fail-closed). Registered in `src/lab-main.ts`'s `LAB_MODULE_PATHS` map
(required — labs are NOT auto-discovered purely by directory; the Vite
`import.meta.glob` in `lab-main.ts` only loads modules whose path appears
in this static map).

**Observed live** via `npm run lab` → `?lab=bosschestrewards-lab`
(not lab-only claim — this is in addition to, not instead of, the
headless/game-pipeline wiring above):

- Reset creates 2 chests in `available` state with 3 real generated
  equipment instances resolved per bundle.
- Open → `revealed`, grants the 3 resolved instances, bundle count drops
  to 0 (claimed by inventory).
- Open again on the same chest → `{ ok: true, alreadyClaimed: true }`,
  no re-grant (idempotency confirmed live).
- Acknowledge on a still-`available` (never-opened) chest →
  `{ ok: false, reason: "invalidTransition" }`, state remains `available`
  (fail-closed confirmed live, no state corruption).

## Verification run

- `npm run verify:fast` — passed.
- `npm run typecheck` / `npx eslint` on all touched/new files — clean.
- `npm run check:wired-systems` — passed.
- `bash scripts/agent/lab-gate-check.sh` — passed (`bossChestRewards` →
  `bosschestrewards-lab` found).
- `npm run review:ledger -- validate` — passed (valid 5-apple ledger).
- `npm run verify:pr-prereqs` — passed after this handoff was added
  (ledger + handoff both satisfied).
- Full unit/integration/headless suites for the feature (see file list
  above) — all passing as part of `verify:fast`'s changed-test step and
  prior full runs during implementation.

## Unresolved issues / follow-ups

- [Issue #1821](https://github.com/nalfeo/Crawler/issues/1821) — 3
  pre-existing carryover-validation gaps outside this branch's diff
  (achievements/inventory/skills/ability-grant array fields), surfaced by
  round-5 multi-model review but determined out-of-scope. Non-blocking;
  filed for a future session.
  Title: "playerCarryover.ts: several array-typed fields lack fail-closed
  element validation (pre-existing)".
- Chest presentation/audio, AI maintenance routing for the new lifecycle
  states, art/sprite assets, and Azure workflows are explicitly out of
  scope per the task brief and are not implemented here.

## Recommended next steps

- A follow-up slice can wire the `available`/`opening`/`revealed`/`claimed`
  states into UX (chest sprite/animation states) and AI maintenance
  routing (e.g. prompting the player toward an available Floor 2 boss
  chest) once art/asset work is scheduled.
- Consider resolving issue #1821 in a small, focused follow-up PR.
