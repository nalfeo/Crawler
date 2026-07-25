import { describe, expect, it } from 'vitest';
import {
  resolveDoorRenderMode,
  GENERATED_DOOR_TEXTURE_KEY,
  DOOR_SHEET_KEY,
  DOOR_CLOSED_FRAME,
  DOOR_OPEN_FRAME,
} from '../../src/engine/sprites/door-visuals.js';

/**
 * Pure precedence logic for door-tile art selection (mode only — the renderer
 * maps a mode to a concrete Image and derives scale from the loaded texture).
 *
 * The matrix that matters:
 *  - PACK: when a pack door texture key is supplied for this state/orientation,
 *    it wins (open and closed both render from the pack).
 *  - CLOSED: generated > Kenney closed frame > solid color.
 *  - OPEN: Kenney open frame > solid color — generated is UNREACHABLE (there is
 *    no approved open-door variant; the non-destructive default keeps open on
 *    Kenney art). The open+gen+sheet case is the regression guard that generated
 *    art never leaks into the open state.
 *  - hasGeneratedClosed is independent of hasSheet: generated wins for a closed
 *    door even with the Kenney sheet absent.
 */
describe('resolveDoorRenderMode', () => {
  it('open + pack door variant → pack texture (pack doorSet takes precedence)', () => {
    expect(
      resolveDoorRenderMode(true, {
        hasGeneratedClosed: true,
        hasSheet: true,
        packDoorTextureKey: 'terrain-pack-industrial-cave-door-open-horizontal',
      }),
    ).toEqual({
      kind: 'pack',
      textureKey: 'terrain-pack-industrial-cave-door-open-horizontal',
    });
  });

  it('closed + pack door variant → pack texture (pack doorSet beats generated/kenney)', () => {
    expect(
      resolveDoorRenderMode(false, {
        hasGeneratedClosed: true,
        hasSheet: true,
        packDoorTextureKey: 'terrain-pack-industrial-cave-door-closed-vertical',
      }),
    ).toEqual({
      kind: 'pack',
      textureKey: 'terrain-pack-industrial-cave-door-closed-vertical',
    });
  });

  it('closed + generated + sheet → generated (generated wins the closed precedence)', () => {
    expect(resolveDoorRenderMode(false, { hasGeneratedClosed: true, hasSheet: true })).toEqual({
      kind: 'generated',
    });
  });

  it('closed + generated + NO sheet → generated (independent of the Kenney sheet)', () => {
    expect(resolveDoorRenderMode(false, { hasGeneratedClosed: true, hasSheet: false })).toEqual({
      kind: 'generated',
    });
  });

  it('closed + no generated + sheet → kenney-closed', () => {
    expect(resolveDoorRenderMode(false, { hasGeneratedClosed: false, hasSheet: true })).toEqual({
      kind: 'kenney-closed',
    });
  });

  it('closed + no generated + no sheet → color(open=false)', () => {
    expect(resolveDoorRenderMode(false, { hasGeneratedClosed: false, hasSheet: false })).toEqual({
      kind: 'color',
      open: false,
    });
  });

  it('open + sheet → kenney-open', () => {
    expect(resolveDoorRenderMode(true, { hasGeneratedClosed: false, hasSheet: true })).toEqual({
      kind: 'kenney-open',
    });
  });

  it('open + no sheet → color(open=true)', () => {
    expect(resolveDoorRenderMode(true, { hasGeneratedClosed: false, hasSheet: false })).toEqual({
      kind: 'color',
      open: true,
    });
  });

  it('open + generated + NO sheet → color(open=true) (generated never leaks into open, even w/o sheet)', () => {
    // Completes the isOpen=true regression guard: the generated closed-door
    // texture must be ignored for an OPEN door in EVERY sheet state, so all four
    // isOpen=true input combinations are pinned (this + the two above + the
    // open+gen+sheet case below).
    expect(resolveDoorRenderMode(true, { hasGeneratedClosed: true, hasSheet: false })).toEqual({
      kind: 'color',
      open: true,
    });
  });

  it('open + generated + sheet → kenney-open (generated NEVER leaks into the open state)', () => {
    // Regression guard for the non-destructive default: even when the generated
    // closed-door texture is available, an OPEN door must stay on Kenney art.
    expect(resolveDoorRenderMode(true, { hasGeneratedClosed: true, hasSheet: true })).toEqual({
      kind: 'kenney-open',
    });
  });

  it('exports the wired manifest key + Kenney frames the renderer stamps', () => {
    // Lock the constants the renderer depends on so a rename can't silently
    // un-wire the generated door or swap the open/closed frames.
    expect(GENERATED_DOOR_TEXTURE_KEY).toBe('tile-door-v1-var-0');
    expect(DOOR_SHEET_KEY).toBe('kenney-tiny-dungeon');
    expect(DOOR_CLOSED_FRAME).toBe(46);
    expect(DOOR_OPEN_FRAME).toBe(34);
  });
});
