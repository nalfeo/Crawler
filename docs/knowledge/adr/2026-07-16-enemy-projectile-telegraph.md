# ADR 2026-07-16: Enemy Projectile Telegraph

## Status

Accepted

## Date

2026-07-16

## Estimated Complexity

🍎 x 5 — new cross-layer data/behavior contract spanning core data model, game
AI fire logic, engine rendering, and the production behavior-tree AI, plus a
new headless CLI knob and full deterministic test coverage.

## Context

Every hostile projectile — including boss and rapid-fire/burst follow-up shots
— fired instantly on the frame the enemy's fire-gate opened, with no visible
warning and no locked aim vector a player (or the production AI) could read
and react to. `BehaviorTreeAI`'s dodge logic only reacted to projectiles that
already existed in the world (`EnemyProjectile` entities in flight); it had no
way to anticipate a shot before it spawned, and its ranged "danger bubble"
around an enemy used a single fixed radius constant regardless of that enemy's
actual attack range.

The approved bounded spec requires:

- A visible telegraph state before every hostile projectile fires, with the
  aim vector locked at telegraph start and held immutable through spawn.
- A per-mob overridable delay (`mob.telegraphMs ?? configuredDefaultTelegraphMs`),
  defaulting to 250ms in both production and the headless CLI, with a new
  `--enemy-telegraph-ms <n>` flag.
- Exact legacy parity at `0`: no cue, no added delay, identical aim/fire timing.
- `BehaviorTreeAI` must dodge the locked trajectory using only the same public,
  deterministic combat state the renderer reads (no privileged prediction),
  and must size its ranged danger evaluation off the enemy's actual attack
  range rather than a fixed constant.
- No retuning of enemy damage, cadence, projectile speed, spawn rates, or
  player stats, and no seed/weapon special-casing, to make tests pass.

## Decision

Introduce a **locked-origin/locked-direction telegraph** as the single source
of truth for render, AI dodge math, and the eventual projectile spawn, so
correctness never depends on preventing enemy displacement during the
telegraph window.

1. **Core data model** (`src/core/components.ts`, `src/core/world.ts`): add
   `enemyBehavior` store fields — `telegraphMs` (per-mob override, `-1`
   sentinel for "unset"), `telegraphActive`, `telegraphStartMs`,
   `telegraphDelayMs`, `telegraphDirX/Y`, `telegraphOriginX/Y`, and
   `telegraphWasActiveThisFrame` (a sticky render-frame flag consumed by the
   renderer, see item 4 below) — plus a world-level `enemyTelegraphMs?: number`
   for the configured default.
2. **Resolver module** (`src/core/systems/enemyTelegraph.ts`, new): a single
   shared helper — `getEffectiveTelegraphMs`, `isEnemyProjectileTelegraphActive`,
   `isEnemyProjectileTelegraphReady`, `startEnemyProjectileTelegraph`,
   `cancelEnemyProjectileTelegraph` — living in `src/core/` so game, engine,
   and game/ai layers can all depend on it without violating layer-import
   rules. `getEffectiveTelegraphMs` implements a **validating** fallback chain
   — `mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`
   — not literal nullish coalescing: any candidate that is negative,
   non-finite, would overflow the Float32-backed `telegraphDelayMs` store, or
   would silently underflow to exactly `0` there (e.g. `1e-50`, which would
   become indistinguishable from an intentional legacy `0` override) is
   treated as absent and falls through to the next level, all the way to the
   hardcoded constant if every level is invalid or unset. An explicit,
   already-`0` value at any level is always legitimate and never falls
   through.
3. **Fire logic** (`src/game/enemyAISystem.ts`): `tryFireEnemyProjectile()`
   becomes a 3-path state machine — already-telegraphing (wait/fire when
   ready), zero-effective-delay (fire immediately, byte-for-byte the old
   behavior), or nonzero-delay (lock origin/direction now, start telegraph).
   The aim/accuracy roll stays at actual fire time (not telegraph start) so
   the RNG draw sequence at `0`ms is identical to today's — an accepted
   consequence is that some telegraphs show a locked trajectory that never
   spawns a projectile if the roll misses, matching today's miss rate.
   Telegraphs are cancelled (never silently left active) on every early-exit
   path that can make the shooter stop being a valid threat before it fires,
   including: aggro-not-yet-enabled, player not detectable, out-of-range,
   no player entity present, an inactive Floor 2 boss encounter, and the
   shooter itself entering its post-death `DeathTimer` linger window
   (`src/game/enemyAISystem.ts`'s early-exit branches, not just
   `tryFireEnemyProjectile()`'s own three).
   Movement is frozen for the enemy while telegraphing (velocity zeroed,
   separation impulses skipped) as a visual/behavioral choice — never as the
   correctness mechanism, since origin/direction are locked independently of
   position.
4. **Render cue** (`src/engine/PhaserBridge.ts`): a per-enemy `Graphics`
   entry draws a pulsing line from the locked origin out to the enemy's
   attack range along the locked direction whenever `telegraphActive` **or**
   the sticky `telegraphWasActiveThisFrame` flag is set, giving players the
   same locked trajectory the AI dodge logic uses. The sticky flag (set by
   `startEnemyProjectileTelegraph`, cleared once per rendered frame by
   `PhaserBridge.sync()`) ensures a telegraph that both starts and completes
   entirely within one multi-step catch-up batch — e.g. the AI-runner's 16×
   playback mode — still draws its cue for one rendered frame, rather than
   the cue being invisibly skipped because `telegraphActive` already
   returned to `0` by the time the frame is drawn.
5. **Production AI** (`src/game/ai/bt-ai-provider.ts`): `buildOpportunisticDodge()`
   gains a second threat loop over telegraphing enemies (`telegraphActive === 1`),
   computing a **virtual projectile's** future impact using the exact same
   closest-approach relative-motion formula as real in-flight projectiles,
   just time-shifted to the projectile's future spawn instant, and gated by
   `canCurrentlyPerceiveWorldPosition()` — a strict-current-FOV sibling of the
   existing `canPerceiveWorldPosition()` (no discovered/remembered-tile
   fallback), matching `PhaserBridge`'s render-cue visibility gate exactly —
   evaluated at the shooter's **live** position, not the locked telegraph
   origin, so a shooter displaced by knockback after locking never lets the
   AI dodge a threat the render cue is not currently showing (no privileged
   access — same visibility rule the player's own cue uses). It competes in
   the same earliest-impact race as real projectiles. `computeRiskRewardFusedHeading()`'s
   danger bubble now uses `max(RISK_REWARD_DANGER_RADIUS_FT, enemy.attackRange)`
   per threat instead of a single fixed radius, so long-range enemies read as
   dangerous from farther away.
6. **CLI** (`headless-runner-cli-lib.ts`, `headless-runner-cli.ts`,
   `headless-runner.ts`): new `--enemy-telegraph-ms <n>` flag, defaulting to
   `ENEMY_PROJECTILE.TELEGRAPH_MS` (250) end-to-end, threaded straight to
   `world.enemyTelegraphMs`. Validation rejects more than plain
   finite/non-negative: `normalizeEnemyTelegraphMs` also rejects values that
   overflow Float32 (e.g. `1e39`, which would round to `Infinity` and freeze
   the enemy in a telegraph that never fires) and values that underflow to
   exactly `0` (e.g. `1e-50`, which `Math.fround` collapses to the same
   Float32 store value as an intentional legacy override, silently discarding
   the requested nonzero delay). `0` itself is still a fully legal, explicit
   override (legacy parity), not treated as "unset."
7. **Test harness default** (`tests/helpers/world-factory.ts`): `createTestWorld()`
   sets `world.enemyTelegraphMs = 0` by default. Production leaves it unset (so
   it falls through to the 250ms constant); the headless CLI defaults to 250
   explicitly. Unit tests default to `0` so the hundreds of pre-existing tests
   that assert immediate enemy-fire behavior continue to exercise exactly
   that legacy path without modification — this **is** the "0 reproduces
   today's behavior" contract being exercised at scale. Tests targeting the
   telegraph feature itself explicitly opt in with
   `createTestWorld({ ... }); world.enemyTelegraphMs = 250;` (or a per-mob
   `telegraphMs` override).
8. **Labs** (`src/labs/ai-runner-lab/index.ts`): the existing dodge/heatmap
   debug overlay is updated to plot the same per-threat radius so the lab
   stays a faithful debugging mirror of production risk math — new code
   reuses the existing `enemyAISystem`/`bt-ai-provider` systems rather than
   introducing a new one, so no new lab is required.

## Consequences

### Positive

- Every hostile shot is now readable and reactable to, in both the real game
  and the production AI, using one shared, deterministic contract instead of
  privileged prediction.
- `0`ms is exact legacy parity by construction (same fire-time accuracy roll,
  same immediate-fire code path) **only when explicitly passed** — a headless
  baseline that omits `--enemy-telegraph-ms` (or otherwise leaves
  `world.enemyTelegraphMs` unset) now defaults to 250ms via
  `ENEMY_PROJECTILE.TELEGRAPH_MS`, changing hostile-fire cadence/AI dodge
  behavior versus pre-PR runs. Only a caller that explicitly passes `0`
  preserves byte-identical legacy behavior; this is an accepted,
  intentional consequence of shipping a non-zero default, not a regression
  in the resolver's `0`-means-legacy contract.
- Per-mob overrides and the configured default share one resolver function,
  so future mobs/bosses opt into custom pacing without touching fire logic.
- Ranged danger evaluation now scales with actual attack range instead of a
  single constant, making long-range threats correctly read as more
  dangerous from farther away.

### Negative

- Total shot-to-shot interval at nonzero telegraph settings becomes
  `fireCooldownMs + telegraphMs`, since the telegraph is inserted strictly
  after the existing cooldown gate. This is an accepted, intentional
  consequence — shrinking `fireCooldownMs` to compensate would itself be a
  forbidden cadence retune per the approved spec, so cadence at nonzero
  settings is left as-is rather than "fixed."
- The `bt-ai-provider.ts` virtual-projectile dodge math must stay in sync
  with `enemyAISystem.ts`'s actual fire-time weapon-def resolution (currently
  the `fireball` weapon def, matching pre-existing behavior) — a future
  change to which weapon def enemies use to fire must update both sites.

### Risks

- If a future mob type fires via a different weapon def than `fireball`, the
  dodge math's assumed speed/AoE could silently diverge from what actually
  spawns. Mitigated by mirroring the exact same fallback chain
  (`weaponDef?.projectileSpeed ?? ENEMY_PROJECTILE.SPEED`) at both sites, and
  flagged here for future maintainers.
- A telegraph that never fires (accuracy miss) still shows a full locked-cue
  and consumes a full dodge-race candidate slot; if a future mob has a very
  low accuracy stat this could look confusing in dense fights. Not addressed
  here — out of scope per "do not retune accuracy to make tests pass."

## Alternatives Considered

- **Prevent all enemy displacement during the telegraph** (fully freeze
  physics, not just velocity) so origin/direction never need explicit
  locking. Rejected: separation/knockback from other systems can still move
  an enemy via direct position writes, so freezing velocity alone doesn't
  guarantee no drift — explicit locked origin/direction is the only
  correctness guarantee that survives any future system touching enemy
  position.
- **Re-roll accuracy/aim at telegraph start instead of fire time.** Rejected:
  this would change the RNG draw order/timing versus today, breaking exact
  `0`ms legacy parity (the spec's hardest constraint) since the accuracy
  check currently happens inline with the fire call.
- **Give `BehaviorTreeAI` direct access to `telegraphMs`/internal AI-only
  state instead of the same public store fields the renderer reads.**
  Rejected per the spec's explicit "no privileged prediction" requirement —
  using the identical `enemyBehavior` store fields the render layer reads
  keeps AI and player-visible information provably in sync.
