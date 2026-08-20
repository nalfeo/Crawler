import type Phaser from 'phaser';
import { type ItemDef, RARITY_COLORS } from '../shared/items.js';
import { fitScaleForBox } from './ui-scale.js';

const TOOLTIP_BG = 0x0a0a16;
const TOOLTIP_BORDER = 0x444466;
const TOOLTIP_WIDTH = 200;
const TOOLTIP_BASE_HEIGHT = 110;
const TOOLTIP_STAT_HEIGHT_BONUS = 18;
const TOOLTIP_META_OFFSET = 16;
const TOOLTIP_FOOTER_OFFSET_FROM_META = 14;
const TOOLTIP_LINE_SPACING = 18;

export interface ItemTooltipRenderParams {
  scene: Phaser.Scene;
  container: Phaser.GameObjects.Container;
  panelX: number;
  panelY: number;
  panelWidth: number;
  panelHeight: number;
  anchorX: number;
  anchorY: number;
  anchorSize: number;
  def: ItemDef;
  quantity: number;
  fontFamily: string;
  /** Optional gold hint line rendered near the bottom (e.g. "DOUBLE-CLICK TO EQUIP"). */
  footerHint?: string;
  /** Optional stat callout rendered above the footer/meta lines. */
  statLine?: string;
  /** Equipment stat rows shown in the item body. */
  statLines?: readonly string[];
  /** Optional flavor copy. It is deliberately secondary to stats. */
  flavorText?: string;
  /** Net comparison rows. These always render at the bottom of the candidate card. */
  diffLines?: readonly string[];
  /** Optional section label such as CURRENT or CANDIDATE. */
  sectionLabel?: string;
  /** Approved generated art key. Falls back to a readable two-letter icon. */
  iconTextureKey?: string;
  /** Explicit card placement used by the equipment inspector. */
  placement?: { x: number; y: number; width: number; height: number };
  crispText: (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ) => Phaser.GameObjects.Text;
}

export function renderItemTooltip(
  params: ItemTooltipRenderParams,
): Phaser.GameObjects.GameObject[] {
  const {
    scene,
    container,
    panelX,
    panelY,
    panelWidth,
    panelHeight,
    anchorX,
    anchorY,
    anchorSize,
    def,
    quantity,
    fontFamily,
    footerHint,
    statLine,
    statLines = [],
    flavorText,
    diffLines = [],
    sectionLabel,
    iconTextureKey,
    placement,
    crispText,
  } = params;

  const richContent =
    statLines.length > 0 ||
    (flavorText !== undefined && flavorText.length > 0) ||
    diffLines.length > 0 ||
    sectionLabel !== undefined;
  const tooltipWidth = placement?.width ?? TOOLTIP_WIDTH;
  const tooltipHeight =
    placement?.height ??
    (statLine !== undefined && statLine.length > 0
      ? TOOLTIP_BASE_HEIGHT + TOOLTIP_STAT_HEIGHT_BONUS
      : richContent
        ? TOOLTIP_BASE_HEIGHT +
          Math.min(3, statLines.length) * 14 +
          (flavorText !== undefined && flavorText.length > 0 ? 14 : 0) +
          Math.min(3, diffLines.length) * 14
        : TOOLTIP_BASE_HEIGHT);
  const metaY = tooltipHeight - TOOLTIP_META_OFFSET;
  const footerY = metaY - TOOLTIP_FOOTER_OFFSET_FROM_META;
  const nextLineY = footerHint !== undefined && footerHint.length > 0 ? footerY : metaY;
  const statY = nextLineY - TOOLTIP_LINE_SPACING;
  const snap = (value: number): number => Math.round(value);
  const panelInset = 8;
  const rightCandidateX = anchorX + anchorSize / 2 + 8;
  const leftCandidateX = anchorX - anchorSize / 2 - tooltipWidth - 8;
  const rightSpace = panelX + panelWidth - panelInset - rightCandidateX;
  const leftSpace = leftCandidateX + tooltipWidth - (panelX + panelInset);
  const preferRight = rightSpace >= tooltipWidth || rightSpace >= leftSpace;
  const tx = snap(
    placement?.x ??
      Math.max(
        panelX + panelInset,
        Math.min(
          preferRight ? rightCandidateX : leftCandidateX,
          panelX + panelWidth - tooltipWidth - panelInset,
        ),
      ),
  );

  const aboveCandidateY = anchorY - anchorSize / 2 - tooltipHeight - 8;
  const belowCandidateY = anchorY + anchorSize / 2 + 8;
  const aboveFits = aboveCandidateY >= panelY + panelInset;
  const belowFits = belowCandidateY <= panelY + panelHeight - tooltipHeight - panelInset;
  const ty = snap(
    placement?.y ??
      Math.max(
        panelY + panelInset,
        Math.min(
          aboveFits ? aboveCandidateY : belowFits ? belowCandidateY : aboveCandidateY,
          panelY + panelHeight - tooltipHeight - panelInset,
        ),
      ),
  );

  const tooltipBg = scene.add.rectangle(
    tx + tooltipWidth / 2,
    ty + tooltipHeight / 2,
    tooltipWidth,
    tooltipHeight,
    TOOLTIP_BG,
    0.95,
  );
  tooltipBg.setStrokeStyle(1, TOOLTIP_BORDER);

  const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;
  container.add(tooltipBg);
  const richIcon = richContent || iconTextureKey !== undefined;
  const iconX = tx + (richIcon ? 22 : tooltipWidth - 22);
  const iconY = ty + (sectionLabel ? 36 : 22);
  const iconObjects: Phaser.GameObjects.GameObject[] = [];
  if (iconTextureKey !== undefined && scene.textures?.exists(iconTextureKey)) {
    const icon = scene.add.image(iconX, iconY, iconTextureKey);
    icon.setOrigin(0.5, 0.5);
    icon.setScale(fitScaleForBox(icon.width, icon.height, richContent ? 28 : 24));
    container.add(icon);
    iconObjects.push(icon);
  } else if (richIcon) {
    const icon = crispText(iconX, iconY, def.name.substring(0, 2).toUpperCase(), {
      fontFamily,
      fontSize: '12px',
      color: `#${rarityColor.toString(16).padStart(6, '0')}`,
    });
    icon.setOrigin(0.5, 0.5);
    container.add(icon);
    iconObjects.push(icon);
  }

  const nameText = crispText(tx + (richIcon ? 42 : 8), ty + (sectionLabel ? 18 : 8), def.name, {
    fontFamily,
    fontSize: richContent ? '13px' : '15px',
    color: `#${rarityColor.toString(16).padStart(6, '0')}`,
    wordWrap: { width: tooltipWidth - (richIcon ? 50 : 16) },
  });

  const bodyX = tx + (richContent ? 8 : 8);
  const bodyY =
    placement !== undefined
      ? ty + (statLines.length > 0 ? 76 : 50)
      : richContent
        ? ty + 50 + Math.min(3, statLines.length) * 14
        : ty + 26;
  const bodyText = flavorText ?? def.description;
  const descText = crispText(bodyX, bodyY, bodyText, {
    fontFamily,
    fontSize: richContent ? '11px' : '12px',
    color: '#9ca3af',
    wordWrap: { width: tooltipWidth - 16 },
  });

  const showMeta = placement === undefined;
  const metaText = showMeta
    ? crispText(tx + 8, ty + metaY, `${def.rarity} · x${quantity} · [${def.tags.join(', ')}]`, {
        fontFamily,
        fontSize: '10px',
        color: '#666688',
      })
    : null;

  if (sectionLabel !== undefined && sectionLabel.length > 0) {
    const labelText = crispText(tx + 8, ty + 4, sectionLabel, {
      fontFamily,
      fontSize: '9px',
      color: '#e9c46a',
    });
    container.add(labelText);
    iconObjects.push(labelText);
  }
  container.add(nameText);
  container.add(descText);
  if (metaText) container.add(metaText);
  const objects: Phaser.GameObjects.GameObject[] = [tooltipBg, ...iconObjects, nameText, descText];
  if (metaText) objects.push(metaText);

  if (statLines.length > 0) {
    const statStartY = placement !== undefined ? ty + 44 : richContent ? ty + 50 : ty + statY;
    statLines.slice(0, 3).forEach((line, index) => {
      const statText = crispText(tx + 8, statStartY + index * TOOLTIP_LINE_SPACING, line, {
        fontFamily,
        fontSize: '11px',
        color: '#d9e2ef',
      });
      container.add(statText);
      objects.push(statText);
    });
  }

  if (statLine !== undefined && statLine.length > 0) {
    const statText = crispText(tx + 8, ty + statY, statLine, {
      fontFamily,
      fontSize: '11px',
      color: '#d9e2ef',
    });
    container.add(statText);
    objects.push(statText);
  }

  // Optional gold action hint (e.g. equip affordance), placed just above meta.
  if (footerHint !== undefined && footerHint.length > 0) {
    const hintText = crispText(tx + 8, ty + footerY, footerHint, {
      fontFamily,
      fontSize: '11px',
      color: '#e9c46a',
    });
    container.add(hintText);
    objects.push(hintText);
  }

  if (diffLines.length > 0) {
    const diffStartY = ty + tooltipHeight - 12 - Math.min(3, diffLines.length) * 14;
    diffLines.slice(0, 3).forEach((line, index) => {
      const diffText = crispText(tx + 8, diffStartY + index * 14, line, {
        fontFamily,
        fontSize: '11px',
        color: line.includes('-') ? '#e8695b' : '#49d06f',
      });
      container.add(diffText);
      objects.push(diffText);
    });
  }

  return objects;
}
