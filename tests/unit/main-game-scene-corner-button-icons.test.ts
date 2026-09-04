/**
 * Corner-button icon presentation guard.
 *
 * The shipped Bag/Gear/Awards/Roster/Command/Skills/Shop/Issue buttons in
 * `MainGameScene` share identical Phaser `Text` styling, so any visual size /
 * weight inconsistency between them comes from the *icon glyph* rather than the
 * text style: a code point without the Unicode `Emoji_Presentation` property
 * (e.g. U+2694 CROSSED SWORDS, U+2691 BLACK FLAG) renders as a small monochrome
 * text glyph next to always-emoji neighbours like 🎒/🏆/🔮.
 *
 * Two failure modes this guard closes deterministically:
 *   • a new (or restored) text-presentation icon slipping into the column;
 *   • "fixing" a text-presentation glyph by appending U+FE0F to a code point
 *     that has no standardized emoji-presentation sequence (U+2691), which
 *     leaves rendering platform-dependent.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync('src/engine/scenes/MainGameScene.ts', 'utf8');

/**
 * The one intentional text-presentation glyph: the Quartermaster button only
 * shows while the shop panel is open, where `✕` reads as a close affordance
 * rather than as an icon. Any other text-presentation icon is a bug.
 */
const EXPECTED_TEXT_PRESENTATION_ICONS = ['✕'];

function stringConstantValue(name: string): string | null {
  const match = new RegExp(`const ${name} = (?:'([^']+)'|"([^"]+)");`).exec(SOURCE);
  return match?.[1] ?? match?.[2] ?? null;
}

function cornerButtonLabels(): string[] {
  const labels: string[] = [];
  const pattern = /makeCornerButton\([^,]*,\s*'([^']+)'/g;
  let match = pattern.exec(SOURCE);
  while (match !== null) {
    labels.push(match[1]!);
    match = pattern.exec(SOURCE);
  }
  const issueLabel = stringConstantValue('ISSUE_BUTTON_LABEL');
  if (issueLabel && /ISSUE_BUTTON_LABEL_COMPACT\s*:\s*ISSUE_BUTTON_LABEL/.test(SOURCE)) {
    labels.push(issueLabel);
  }
  return labels;
}

/** Leading icon of a label, including a trailing U+FE0F variation selector. */
function iconOf(label: string): string {
  const [first, second] = [...label];
  return second === '\uFE0F' ? `${first}${second}` : (first ?? '');
}

/**
 * The canonical shipped column, pinned so a button added/renamed with a label
 * this file's extraction cannot see (a constant, a template literal, double
 * quotes) fails loudly instead of silently escaping the icon checks below.
 */
const EXPECTED_LABELS = [
  '🎒 Bag',
  '⚔️ Gear',
  '🏆 Awards',
  '🐾 Roster',
  '⚡ Command',
  '🔮 Skills',
  '✕ Shop',
  '🚩 Issue',
];

describe('MainGameScene corner-button icons', () => {
  const labels = cornerButtonLabels();
  const iconLabels = [...labels, stringConstantValue('ISSUE_BUTTON_LABEL_COMPACT')].filter(
    (label): label is string => label !== null,
  );

  it('finds every corner button label', () => {
    expect(labels).toEqual(EXPECTED_LABELS);
    expect(SOURCE.match(/makeCornerButton\(/g)?.length).toBe(EXPECTED_LABELS.length);
  });

  it('renders every icon as colour emoji except the documented close glyph', () => {
    const textPresentation = iconLabels
      .map((label) => iconOf(label))
      .filter((icon) => !/^\p{Emoji_Presentation}$/u.test(icon) && !icon.endsWith('\uFE0F'));

    expect(textPresentation).toEqual(EXPECTED_TEXT_PRESENTATION_ICONS);
  });

  it('never fakes emoji presentation with U+FE0F on a non-emoji code point', () => {
    // U+FE0F only forces emoji presentation for code points carrying the
    // Unicode `Emoji` property (e.g. U+2694 ⚔️); on anything else — notably
    // U+2691 ⚑ BLACK FLAG, which has no standardized emoji-variation sequence
    // — the selector is inert and the glyph stays platform-dependent.
    for (const label of iconLabels) {
      const icon = iconOf(label);
      if (!icon.endsWith('\uFE0F')) {
        continue;
      }
      const base = [...icon][0]!;
      expect(/^\p{Emoji}$/u.test(base), `${label}: U+FE0F on a non-emoji base glyph`).toBe(true);
    }
    expect(iconLabels.some((label) => label.includes('\u2691'))).toBe(false);
  });
});
