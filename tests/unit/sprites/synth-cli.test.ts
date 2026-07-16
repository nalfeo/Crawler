/**
 * Unit tests for the sprites:synth CLI argument parser.
 *
 * The CLI itself is a thin wrapper around `synthesizeBrief`; the only
 * non-trivial logic is `parseArgs`. Validating it here keeps `main()`
 * a straight-line wiring layer that doesn't need its own tests.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/sprites/synth-cli.js';

describe('synth-cli parseArgs', () => {
  it('parses a name on its own with sensible defaults', () => {
    const args = parseArgs(['scythe']);
    expect(args).toEqual({
      name: 'scythe',
      type: undefined,
      candidates: 3,
      allowPartial: false,
      size: 'default',
      floor: 1,
    });
  });

  it('parses --type and --candidates flags', () => {
    const args = parseArgs(['devils-yoyo', '--type', 'weapon', '--candidates', '5']);
    expect(args.name).toBe('devils-yoyo');
    expect(args.type).toBe('weapon');
    expect(args.candidates).toBe(5);
    expect(args.allowPartial).toBe(false);
    expect(args.size).toBe('default');
  });

  it('parses --size variants and defaults to "default" when omitted', () => {
    expect(parseArgs(['ogre', '--size', 'wide']).size).toBe('wide');
    expect(parseArgs(['ogre', '--size', 'tall']).size).toBe('tall');
    expect(parseArgs(['ogre', '--size', 'large']).size).toBe('large');
    expect(parseArgs(['ogre']).size).toBe('default');
  });

  it('rejects an unknown --size variant', () => {
    expect(() => parseArgs(['ogre', '--size', 'huge'])).toThrow(/not one of/);
  });

  it('rejects a missing value for --size', () => {
    expect(() => parseArgs(['ogre', '--size'])).toThrow(/--size requires a value/);
  });

  it('parses --allow-partial as a boolean switch', () => {
    const args = parseArgs(['scythe', '--allow-partial']);
    expect(args.allowPartial).toBe(true);
  });

  it('parses --floor and rejects values outside 1 through 20', () => {
    expect(parseArgs(['llama', '--floor', '2']).floor).toBe(2);
    expect(() => parseArgs(['llama', '--floor', '0'])).toThrow(/integer in \[1, 20\]/);
    expect(() => parseArgs(['llama', '--floor', '21'])).toThrow(/integer in \[1, 20\]/);
    expect(() => parseArgs(['llama', '--floor', '2.5'])).toThrow(/integer in \[1, 20\]/);
  });

  it('rejects an unknown sprite type', () => {
    expect(() => parseArgs(['scythe', '--type', 'gadget'])).toThrow(/not one of/);
  });

  it('rejects non-integer or out-of-range --candidates', () => {
    expect(() => parseArgs(['scythe', '--candidates', '0'])).toThrow();
    expect(() => parseArgs(['scythe', '--candidates', '10'])).toThrow();
    expect(() => parseArgs(['scythe', '--candidates', '2.5'])).toThrow();
    expect(() => parseArgs(['scythe', '--candidates', 'foo'])).toThrow();
  });

  it('rejects missing values for --type and --candidates', () => {
    expect(() => parseArgs(['scythe', '--type'])).toThrow(/--type requires a value/);
    expect(() => parseArgs(['scythe', '--candidates'])).toThrow(/--candidates requires a value/);
  });

  it('rejects unknown flags', () => {
    expect(() => parseArgs(['scythe', '--bogus'])).toThrow(/Unknown flag: --bogus/);
  });

  it('rejects a second positional argument', () => {
    expect(() => parseArgs(['scythe', 'extra'])).toThrow(/Unexpected positional/);
  });

  it('requires a name', () => {
    expect(() => parseArgs([])).toThrow(/Missing subject name/);
    expect(() => parseArgs(['--type', 'weapon'])).toThrow(/Missing subject name/);
  });
});
