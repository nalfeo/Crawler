import { describe, it, expect } from 'vitest';
import {
  PICKUP_SPARKLE_COLORS,
  VFX_EVENT_CAP,
  pushVfxEvent,
  type VfxEvent,
} from '../../src/shared/vfx-events.js';

describe('vfx-events', () => {
  describe('pushVfxEvent', () => {
    it('appends an event to the queue', () => {
      const events: VfxEvent[] = [];
      pushVfxEvent(events, { kind: 'pickupSparkle', x: 1, y: 2 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'pickupSparkle', x: 1, y: 2 });
    });

    it('caps the queue at VFX_EVENT_CAP, dropping the oldest', () => {
      const events: VfxEvent[] = [];
      for (let i = 0; i < VFX_EVENT_CAP + 50; i++) {
        pushVfxEvent(events, { kind: 'hitSpark', x: i, y: 0 });
      }
      expect(events).toHaveLength(VFX_EVENT_CAP);
      // Oldest 50 were dropped, so the first retained event is index 50.
      expect(events[0]).toMatchObject({ x: 50 });
      expect(events[events.length - 1]).toMatchObject({ x: VFX_EVENT_CAP + 49 });
    });

    it('does not splice when exactly at the cap', () => {
      const events: VfxEvent[] = [];
      for (let i = 0; i < VFX_EVENT_CAP; i++) {
        pushVfxEvent(events, { kind: 'hitSpark', x: i, y: 0 });
      }
      expect(events).toHaveLength(VFX_EVENT_CAP);
      expect(events[0]).toMatchObject({ x: 0 });
    });
  });

  describe('PICKUP_SPARKLE_COLORS', () => {
    it('defines a distinct colour for each pickup kind', () => {
      const colors = Object.values(PICKUP_SPARKLE_COLORS);
      expect(new Set(colors).size).toBe(colors.length);
    });

    it('uses cyan for gems, gold for gold, white for items', () => {
      expect(PICKUP_SPARKLE_COLORS.gem).toBe(0x44ddff);
      expect(PICKUP_SPARKLE_COLORS.gold).toBe(0xffd166);
      expect(PICKUP_SPARKLE_COLORS.item).toBe(0xffffff);
    });
  });
});
