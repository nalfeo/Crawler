/**
 * The scenario → presentation contract.
 *
 * A floor scenario (`src/game/scenarioDefinitions.ts`) declares everything the
 * presentation layer needs to narrate, mark, prompt, and conclude a run; the
 * renderer (`src/engine/scenes/MainGameScene.ts`) consumes that contract
 * without ever branching on floor identity. The types live here in the leaf
 * layer so both sides can name the same shape while `src/engine/` keeps its
 * ban on importing `src/game/`.
 *
 * Every contract member is generic over the world type (`TWorld`) because
 * `src/shared/` must not import `src/core/`; both consumers instantiate it as
 * `ScenarioPresentationContract<GameWorld>`.
 */

/**
 * Canonical terminal outcome for a floor run. This is the SOLE signal every
 * completion-selection decision (which screen, which copy) derives from —
 * {@link selectScenarioCompletionVariant} never re-derives victory/defeat from
 * any other world shape once a scenario reports an outcome here.
 */
export type ScenarioRunOutcome = 'cleared_floor' | 'failed_timeout';

/** Which completion-screen branch a terminal outcome should present. */
export type ScenarioCompletionVariant =
  | 'failed_timeout'
  | 'transition_to_next_floor'
  | 'terminal_victory'
  | 'terminal_complete';

/** Presentation copy for a single completion-screen variant. */
export interface ScenarioCompletionCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
}

/**
 * Semantic (no Phaser/pixel/color/depth) presentation state for the
 * floor-exit stair marker and its proximity radius. Distances are expressed in
 * feet, matching every other gameplay distance in `src/shared` — the renderer
 * alone converts to pixels and picks colors.
 */
export interface ScenarioStairMarkerState {
  readonly positionFt: { readonly x: number; readonly y: number };
  readonly radiusFt: number;
  /** True while the marker should be shown (stairs spawned, not yet taken). */
  readonly visible: boolean;
  /**
   * True while descent is barred. The renderer chooses its own locked styling,
   * and the interaction layer never offers the descend prompt while this is
   * set — so it must agree with whatever the scenario's `onStairDescend`
   * accepts, otherwise a confirmed descent would be silently rejected.
   */
  readonly locked: boolean;
  readonly label: string;
}

/** Presentation copy for the stair-descend confirmation prompt. */
export interface ScenarioStairConfirmationCopy {
  readonly title: string;
  readonly subtitle: string;
  readonly body: string;
  readonly confirmLabel: string;
  readonly confirmDescription: string;
}

/**
 * One ordered Director-commentary beat, shown strictly between `intro` and
 * `victory`/`timeout`. `id` is the stable identifier the presenting layer
 * latches "already shown" against — ids must never be reordered or reused for
 * a different beat once shipped.
 */
export interface ScenarioDirectorMilestone<TWorld> {
  readonly id: string;
  readonly copy: string;
  readonly isReached: (world: TWorld) => boolean;
}

export interface ScenarioDirectorContract<TWorld> {
  readonly intro: string;
  readonly victory: string;
  readonly timeout?: string;
  /**
   * Ordered beats between `intro` and `victory`/`timeout`. Empty for scenarios
   * with no mid-run commentary. Order is the presentation order; a milestone's
   * own `isReached` predicate is what gates it, not array position alone.
   */
  readonly milestones: ReadonlyArray<ScenarioDirectorMilestone<TWorld>>;
  /**
   * True once the top-level `victory` beat should fire. Kept independent of
   * `getRunOutcome` because "victory announced" is a per-scenario judgment a
   * single terminal-outcome signal cannot express: Floor 1 fires it exactly
   * when the stairs are taken, while Floor 2 fires it the moment the family
   * feud resolves — well before the exit stairs are reached.
   */
  readonly isVictoryReached: (world: TWorld) => boolean;
  /**
   * True once the top-level `timeout` beat should fire. Only consulted when
   * `timeout` copy is set.
   */
  readonly isTimeoutReached?: (world: TWorld) => boolean;
}

/**
 * The normalized, engine-facing slice of a scenario definition — everything a
 * presentation layer needs to render Director commentary, the stair
 * marker/confirmation, and the completion screen, with zero floor-identity
 * branching.
 */
export interface ScenarioPresentationContract<TWorld> {
  readonly director: ScenarioDirectorContract<TWorld>;
  /**
   * Canonical terminal-outcome selector — pure with respect to `world`, and
   * the sole input {@link selectScenarioCompletionVariant} consults.
   */
  readonly getRunOutcome: (world: TWorld) => ScenarioRunOutcome | null;
  /**
   * True when a terminal `cleared_floor` outcome with no next floor should
   * present as a genuine run-ending victory rather than a generic "complete"
   * screen. Static per scenario so completion-variant selection stays a pure
   * function of (`outcome`, `nextFloorId`, `isTerminalRunVictory`).
   */
  readonly isTerminalRunVictory?: boolean;
  /** Copy for every completion-screen variant this scenario can reach. */
  readonly getCompletionCopy: (variant: ScenarioCompletionVariant) => ScenarioCompletionCopy;
  /**
   * Semantic stair-marker/proximity state, or `null` while there is nothing to
   * show (no stairs spawned yet, or this scenario has none). Optional so
   * scenarios without a floor exit stay valid.
   */
  readonly getStairMarkerState?: (world: TWorld) => ScenarioStairMarkerState | null;
  /** Copy for the stair-descend confirmation prompt. */
  readonly stairConfirmation?: ScenarioStairConfirmationCopy;
  /** Identifier of the floor this scenario hands off to, when it has one. */
  readonly nextFloorId?: string;
}

/**
 * Chooses which completion-screen variant a terminal `outcome` should present.
 * Pure function of `outcome` (the sole "is this run over, and how" signal)
 * plus two static-per-scenario fields that only disambiguate *which*
 * non-failure screen to show. No floor identity is ever consulted, so this
 * generalizes to any number of registered scenarios.
 */
export function selectScenarioCompletionVariant(
  outcome: ScenarioRunOutcome | null,
  scenario: {
    readonly nextFloorId?: string;
    readonly isTerminalRunVictory?: boolean;
  },
): ScenarioCompletionVariant | null {
  if (outcome === null) {
    return null;
  }
  if (outcome === 'failed_timeout') {
    return 'failed_timeout';
  }
  if (scenario.nextFloorId) {
    return 'transition_to_next_floor';
  }
  return scenario.isTerminalRunVictory === true ? 'terminal_victory' : 'terminal_complete';
}
