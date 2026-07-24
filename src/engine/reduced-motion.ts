/**
 * Reads the browser's `prefers-reduced-motion` media query.
 *
 * This is the only source of truth the reward-opening UX uses for reduced
 * motion — there is no in-game settings toggle yet. Guarded so it is safe to
 * call from headless/test environments (jsdom without `matchMedia`, Node),
 * where it fails closed to `false` (full motion) rather than throwing.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}
