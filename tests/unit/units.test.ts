import { describe, expect, it } from 'vitest';
import { ftToPx, pxToFt, formatFeet, PIXELS_PER_FOOT } from '../../src/shared/units.js';

describe('units', () => {
  describe('ftToPx', () => {
    it('converts zero feet to zero pixels', () => {
      expect(ftToPx(0)).toBe(0);
    });

    it('converts positive feet to pixels', () => {
      expect(ftToPx(1)).toBe(PIXELS_PER_FOOT);
      expect(ftToPx(5)).toBe(40);
      expect(ftToPx(10)).toBe(80);
    });

    it('converts fractional feet to pixels', () => {
      expect(ftToPx(0.5)).toBe(4);
      expect(ftToPx(1.5)).toBe(12);
      expect(ftToPx(1.75)).toBe(14);
    });

    it('handles negative feet', () => {
      expect(ftToPx(-1)).toBe(-PIXELS_PER_FOOT);
      expect(ftToPx(-5)).toBe(-40);
    });

    it('multiplies by PIXELS_PER_FOOT constant', () => {
      const feet = 7.25;
      expect(ftToPx(feet)).toBe(feet * PIXELS_PER_FOOT);
    });
  });

  describe('pxToFt', () => {
    it('converts zero pixels to zero feet', () => {
      expect(pxToFt(0)).toBe(0);
    });

    it('converts positive pixels to feet', () => {
      expect(pxToFt(8)).toBe(1);
      expect(pxToFt(40)).toBe(5);
      expect(pxToFt(80)).toBe(10);
    });

    it('converts non-divisible pixels to fractional feet', () => {
      expect(pxToFt(4)).toBe(0.5);
      expect(pxToFt(12)).toBe(1.5);
      expect(pxToFt(33)).toBeCloseTo(4.125, 10);
    });

    it('handles negative pixels', () => {
      expect(pxToFt(-8)).toBe(-1);
      expect(pxToFt(-40)).toBe(-5);
    });

    it('divides by PIXELS_PER_FOOT constant', () => {
      const pixels = 58;
      expect(pxToFt(pixels)).toBe(pixels / PIXELS_PER_FOOT);
    });
  });

  describe('formatFeet', () => {
    it('formats zero pixels', () => {
      expect(formatFeet(0)).toBe("0'");
    });

    it('formats pixel values with whole feet', () => {
      expect(formatFeet(8)).toBe("1'");
      expect(formatFeet(40)).toBe("5'");
      expect(formatFeet(80)).toBe("10'");
    });

    it('formats pixel values with fractional feet rounded to one decimal', () => {
      expect(formatFeet(4)).toBe("0.5'");
      expect(formatFeet(12)).toBe("1.5'");
      // 33 pixels = 4.125 feet, should round to "4.1'"
      expect(formatFeet(33)).toBe("4.1'");
      // 20 pixels = 2.5 feet, should be "2.5'"
      expect(formatFeet(20)).toBe("2.5'");
    });

    it('rounds to one decimal place correctly', () => {
      // 35 pixels = 4.375 feet, should round to "4.4'"
      expect(formatFeet(35)).toBe("4.4'");
      // 37 pixels = 4.625 feet, should round to "4.6'"
      expect(formatFeet(37)).toBe("4.6'");
      // 26 pixels = 3.25 feet, should round to "3.3'" (rounded up)
      expect(formatFeet(26)).toBe("3.3'");
    });

    it('includes the feet symbol', () => {
      const result = formatFeet(16);
      expect(result).toMatch(/'$/);
      expect(result).toBe("2'");
    });

    it('handles negative pixels', () => {
      expect(formatFeet(-8)).toBe("-1'");
      expect(formatFeet(-4)).toBe("-0.5'");
    });

    it('handles large pixel values', () => {
      expect(formatFeet(1000)).toMatch(/'$/);
      const feet = 1000 / PIXELS_PER_FOOT;
      const rounded = Math.round(feet * 10) / 10;
      expect(formatFeet(1000)).toBe(`${rounded}'`);
    });
  });

  describe('conversion round-trips', () => {
    it('round-trips feet to pixels and back', () => {
      const original = 5;
      const pixels = ftToPx(original);
      const backToFeet = pxToFt(pixels);
      expect(backToFeet).toBe(original);
    });

    it('round-trips pixels to feet and back', () => {
      const original = 40;
      const feet = pxToFt(original);
      const backToPixels = ftToPx(feet);
      expect(backToPixels).toBe(original);
    });

    it('handles fractional round-trips', () => {
      const original = 2.75;
      const pixels = ftToPx(original);
      const backToFeet = pxToFt(pixels);
      expect(backToFeet).toBeCloseTo(original, 10);
    });
  });
});
