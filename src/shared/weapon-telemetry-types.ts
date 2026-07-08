/**
 * Pure data shapes for optional per-run weapon telemetry (swings, connecting
 * hits, accuracy, multi-hit rate for the PLAYER's attacks).
 *
 * These interfaces live in `src/shared/` — the leaf layer — because they are
 * consumed by both `src/core/` (the live collector + `GameWorld` mutators in
 * `src/core/weapon-telemetry.ts`) and the recorder/runner surfaces in
 * `src/game/` and `src/shared/session-recorder-types.ts`. Keeping just the
 * data shapes here lets `SessionRecorderStats` reference the summary without
 * `src/shared/` importing from `src/core/` (which the layer rules forbid).
 *
 * Pure data only: no Phaser, no bitecs world mutation, no RNG. The collector
 * factory, the `GameWorld` mutators, and `summarizeWeaponTelemetry` live in
 * `src/core/weapon-telemetry.ts`.
 */

/** Live per-run collector attached to `world.weaponTelemetry` when enabled. */
export interface WeaponTelemetry {
  /** Total weapon activations (every `dispatchAttack` that fired), incl. whiffs. */
  swings: number;
  /** Subset of `swings` that whiffed on the accuracy roll (cosmetic-only miss). */
  accuracyMisses: number;
  /** Next activation id to hand out (monotonic, never reused). */
  nextActivationId: number;
  /**
   * Activation id of the in-flight `dispatchAttack`, or `undefined` between
   * activations. Only ever set inside a PLAYER weapon dispatch, so attack
   * entities spawned by enemy systems (which do not run during that window)
   * remain untagged.
   */
  currentActivationId: number | undefined;
  /** attack-entity eid → owning activation id. Pruned when the entity is cleared. */
  entityActivation: Map<number, number>;
  /**
   * activation id → set of distinct enemy eids it damaged. Created lazily on the
   * first recorded hit, so non-connecting activations never allocate a set and
   * `enemiesByActivation.size === connectingSwings`.
   */
  enemiesByActivation: Map<number, Set<number>>;
}

/** Read-only rollup of a {@link WeaponTelemetry} collector. */
export interface WeaponTelemetrySummary {
  /** Total weapon activations (auto-attacks fired), including whiffs. */
  swings: number;
  /** Activations that whiffed on the accuracy roll. */
  accuracyMisses: number;
  /** Activations that damaged >= 1 enemy. */
  connectingSwings: number;
  /** Activations that damaged >= 2 distinct enemies (AoE / arc sweep / pierce). */
  multiHitSwings: number;
  /** Sum of distinct enemies damaged across all connecting activations. */
  totalEnemyHits: number;
  /** connectingSwings / swings (0 when there were no swings). */
  accuracy: number;
  /** multiHitSwings / connectingSwings (0 when nothing connected). */
  multiHitRate: number;
  /** totalEnemyHits / connectingSwings (0 when nothing connected). */
  avgEnemiesPerConnectingSwing: number;
}
