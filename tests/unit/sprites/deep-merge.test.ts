/**
 * Pure-function tests for the deep-merge helper used by the brief loader.
 * The semantics that matter most: per-leaf scalars from the override win,
 * arrays REPLACE rather than concatenate, and inputs are not mutated.
 */

import { describe, expect, it } from 'vitest';
import { deepMergeDefaults } from '../../../scripts/sprites/deep-merge.js';

describe('deepMergeDefaults', () => {
  it('keeps defaults when override is undefined', () => {
    const defaults = { a: 1, b: { c: 2 } };
    expect(deepMergeDefaults(defaults, undefined)).toEqual(defaults);
  });

  it('overrides scalars per leaf', () => {
    const defaults = { a: 1, b: 2 };
    expect(deepMergeDefaults(defaults, { b: 5 })).toEqual({ a: 1, b: 5 });
  });

  it('recursively merges nested objects', () => {
    const defaults = { a: { x: 1, y: 2 }, b: 3 };
    expect(deepMergeDefaults(defaults as Record<string, unknown>, { a: { y: 22 } })).toEqual({
      a: { x: 1, y: 22 },
      b: 3,
    });
  });

  it('replaces arrays wholesale rather than concatenating', () => {
    const defaults = { refs: ['a', 'b', 'c'] };
    expect(deepMergeDefaults(defaults, { refs: ['x'] })).toEqual({ refs: ['x'] });
  });

  it('does not mutate the defaults input', () => {
    const defaults = { a: { x: 1 }, refs: [1, 2] };
    deepMergeDefaults(defaults as Record<string, unknown>, { a: { x: 99 }, refs: [9] });
    expect(defaults).toEqual({ a: { x: 1 }, refs: [1, 2] });
  });

  it('does not mutate the override input', () => {
    const defaults = { a: { x: 1 } };
    const override = { a: { x: 99 } };
    deepMergeDefaults(defaults, override);
    expect(override).toEqual({ a: { x: 99 } });
  });

  it('ignores undefined keys in the override (does not blank out a default)', () => {
    const defaults = { a: 1, b: 2 };
    expect(deepMergeDefaults(defaults, { b: undefined as unknown as number })).toEqual({
      a: 1,
      b: 2,
    });
  });

  it('replaces an object with a non-object override (e.g., null)', () => {
    const defaults = { a: { x: 1 } };
    expect(deepMergeDefaults(defaults, { a: null as unknown as { x: number } })).toEqual({
      a: null,
    });
  });

  it('handles overriding a scalar with an object', () => {
    const defaults = { a: 1 as unknown as { x: number } };
    expect(deepMergeDefaults(defaults, { a: { x: 5 } })).toEqual({ a: { x: 5 } });
  });
});
