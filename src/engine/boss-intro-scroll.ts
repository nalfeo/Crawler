/**
 * Pure scroll-window math for the fixed-size boss introduction sheet.
 *
 * `BossIntroUI` renders a FIXED sheet, so a long Director monologue is shown
 * through a line window with a scrollbar instead of growing the frame (or
 * shrinking the font until the copy is unreadable). All the arithmetic lives
 * here so it is unit-testable without booting Phaser.
 */

/** A clamped view over a wrapped block of text. */
export interface ScrollWindow {
  /** First visible line index, clamped into `[0, maxIndex]`. */
  readonly index: number;
  /** Largest legal first-line index (0 when everything fits). */
  readonly maxIndex: number;
  /** Number of lines the viewport can show (always ≥ 1). */
  readonly visibleLines: number;
  /** True when at least one line is outside the viewport. */
  readonly scrollable: boolean;
}

/** Scrollbar thumb geometry in the same space as the track. */
export interface ScrollThumb {
  readonly y: number;
  readonly height: number;
}

/** Smallest thumb we ever draw, so it stays grabbable on huge documents. */
const MIN_THUMB_HEIGHT = 18;

/**
 * Clamp a requested first-line index against the copy and the viewport.
 *
 * `visibleLines` is floored at 1 so a viewport too short for a single line
 * still shows something rather than rendering an empty sheet.
 */
export function computeScrollWindow(
  totalLines: number,
  visibleLines: number,
  requestedIndex: number,
): ScrollWindow {
  const total = Math.max(0, Math.floor(totalLines));
  const visible = Math.max(1, Math.floor(visibleLines));
  const maxIndex = Math.max(0, total - visible);
  const index = Math.min(maxIndex, Math.max(0, Math.floor(requestedIndex)));
  return { index, maxIndex, visibleLines: visible, scrollable: maxIndex > 0 };
}

/**
 * Thumb position/size for a vertical scrollbar track starting at `trackY`.
 *
 * The thumb length is proportional to the visible fraction of the copy and the
 * travel is proportional to `index / maxIndex`, so a full scroll lands the
 * thumb exactly at the bottom of the track.
 */
export function computeScrollThumb(
  trackY: number,
  trackHeight: number,
  window: ScrollWindow,
  totalLines: number,
): ScrollThumb {
  const total = Math.max(1, Math.floor(totalLines));
  const visibleFraction = Math.min(1, window.visibleLines / total);
  const height = Math.min(
    trackHeight,
    Math.max(MIN_THUMB_HEIGHT, Math.round(trackHeight * visibleFraction)),
  );
  const travel = trackHeight - height;
  const progress = window.maxIndex === 0 ? 0 : window.index / window.maxIndex;
  return { y: trackY + travel * progress, height };
}
