/**
 * Shared constants for the Floor 3 seed-3539 dual-runner completion contract
 * (the `floor-3-ai-runner-completion` epic's `dual-runner-acceptance` gate).
 *
 * Both halves of the contract — the headless gate
 * (`tests/headless/floor3-completion.test.ts`) and the visual gate
 * (`tests/e2e/floor3-ai-completion.deterministic.test.ts`) — import from here
 * rather than each declaring their own copy: the epic requires "one committed
 * deterministic seed shared by both runners", and a duplicated literal edited
 * in only one file would silently break that guarantee. Mirrors the existing
 * `floor4-completion-contract.ts` pattern.
 */

/**
 * The one committed deterministic seed both the headless and visual
 * acceptance tests drive. An unmodified probe of this seed died at frame
 * 1,907 before the Floor-3 objective-navigation and companion-tuning work
 * landed (see `tests/headless/floor3-completion.test.ts`'s header comment);
 * this is the seed that reaches victory under current production tuning.
 */
export const FLOOR3_COMPLETION_SEED = 3539;

/**
 * Floor-3-only, human-authorized "higher initial level" headless/e2e test
 * config knob (raises only the AI-controlled player character's starting
 * level, same as every other floor's headless tests do to skip grind and
 * focus the assertion on the system under test) — not a runtime player
 * cheat and not a balance change.
 */
export const FLOOR3_COMPLETION_START_PLAYER_LEVEL = 20;

/**
 * The ordered sequence of blocking Floor 3 presentation surfaces the AI must
 * encounter and resolve, in this order, to reach the production victory/exit
 * outcome. Shared with `floor3-ai-runner-dialog-autonomy.deterministic.test.ts`'s
 * own (narrower) `REQUIRED_SEQUENCE`.
 */
export const FLOOR3_REQUIRED_SURFACE_SEQUENCE = [
  'floor3-intro',
  'floor3-starter',
  'floor3-studio-versus',
  'floor3-poach',
  'floor3-final-four-versus',
  'floor3-keep-companion',
  'floor3-stair-descend',
] as const;

export type Floor3SurfaceKind = (typeof FLOOR3_REQUIRED_SURFACE_SEQUENCE)[number];

/**
 * The exact number of times each repeated surface must open/confirm across
 * the full run: 6 Studios, 5 poach offers (one per defeated Studio rival
 * except the last, matching the roster contract), 4 ordered Final Four
 * rounds, and exactly one each of the one-shot surfaces.
 */
export const FLOOR3_SURFACE_EXPECTED_COUNTS: Record<Floor3SurfaceKind, number> = {
  'floor3-intro': 1,
  'floor3-starter': 1,
  'floor3-studio-versus': 6,
  'floor3-poach': 5,
  'floor3-final-four-versus': 4,
  'floor3-keep-companion': 1,
  'floor3-stair-descend': 1,
};

/** Minimum consecutive simulated milliseconds alive outside the spawn room. */
export const FLOOR3_MIN_ALIVE_OUTSIDE_SPAWN_MS = 10_000;
