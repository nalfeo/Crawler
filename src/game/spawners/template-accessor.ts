/**
 * Template accessor utilities for spawner registry.
 * Provides convenient access to mob templates.
 */

import type { MobTemplate } from './types.js';
import { RAT } from './registry.js';

export function getRatTemplate(): MobTemplate {
  return RAT;
}
