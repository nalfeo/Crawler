import type Phaser from 'phaser';
import { type ItemDef, RARITY_COLORS } from '../shared/items.js';

const TOOLTIP_BG = 0x0a0a16;
const TOOLTIP_BORDER = 0x444466;
const TOOLTIP_WIDTH = 200;
const TOOLTIP_HEIGHT = 128;

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
    crispText,
  } = params;

  const snap = (value: number): number => Math.round(value);
  const panelInset = 8;
  const rightCandidateX = anchorX + anchorSize / 2 + 8;
  const leftCandidateX = anchorX - anchorSize / 2 - TOOLTIP_WIDTH - 8;
  const rightSpace = panelX + panelWidth - panelInset - rightCandidateX;
  const leftSpace = leftCandidateX + TOOLTIP_WIDTH - (panelX + panelInset);
  const preferRight = rightSpace >= TOOLTIP_WIDTH || rightSpace >= leftSpace;
  const tx = snap(
    Math.max(
      panelX + panelInset,
      Math.min(
        preferRight ? rightCandidateX : leftCandidateX,
        panelX + panelWidth - TOOLTIP_WIDTH - panelInset,
      ),
    ),
  );

  const aboveCandidateY = anchorY - anchorSize / 2 - TOOLTIP_HEIGHT - 8;
  const belowCandidateY = anchorY + anchorSize / 2 + 8;
  const aboveFits = aboveCandidateY >= panelY + panelInset;
  const belowFits = belowCandidateY <= panelY + panelHeight - TOOLTIP_HEIGHT - panelInset;
  const ty = snap(
    Math.max(
      panelY + panelInset,
      Math.min(
        aboveFits ? aboveCandidateY : belowFits ? belowCandidateY : aboveCandidateY,
        panelY + panelHeight - TOOLTIP_HEIGHT - panelInset,
      ),
    ),
  );

  const tooltipBg = scene.add.rectangle(
    tx + TOOLTIP_WIDTH / 2,
    ty + TOOLTIP_HEIGHT / 2,
    TOOLTIP_WIDTH,
    TOOLTIP_HEIGHT,
    TOOLTIP_BG,
    0.95,
  );
  tooltipBg.setStrokeStyle(1, TOOLTIP_BORDER);

  const rarityColor = RARITY_COLORS[def.rarity] ?? 0x9e9e9e;
  const nameText = crispText(tx + 8, ty + 8, def.name, {
    fontFamily,
    fontSize: '15px',
    color: `#${rarityColor.toString(16).padStart(6, '0')}`,
    wordWrap: { width: TOOLTIP_WIDTH - 16 },
  });

  const descText = crispText(tx + 8, ty + 26, def.description, {
    fontFamily,
    fontSize: '12px',
    color: '#9ca3af',
    wordWrap: { width: TOOLTIP_WIDTH - 16 },
  });

  const metaText = crispText(
    tx + 8,
    ty + TOOLTIP_HEIGHT - 16,
    `${def.rarity} · x${quantity} · [${def.tags.join(', ')}]`,
    {
      fontFamily,
      fontSize: '11px',
      color: '#666688',
    },
  );

  container.add(tooltipBg);
  container.add(nameText);
  container.add(descText);
  container.add(metaText);
  const objects: Phaser.GameObjects.GameObject[] = [tooltipBg, nameText, descText, metaText];

  if (statLine !== undefined && statLine.length > 0) {
    const statText = crispText(tx + 8, ty + TOOLTIP_HEIGHT - (footerHint ? 48 : 34), statLine, {
      fontFamily,
      fontSize: '11px',
      color: '#d9e2ef',
    });
    container.add(statText);
    objects.push(statText);
  }

  // Optional gold action hint (e.g. equip affordance), placed just above meta.
  if (footerHint !== undefined && footerHint.length > 0) {
    const hintText = crispText(tx + 8, ty + TOOLTIP_HEIGHT - 30, footerHint, {
      fontFamily,
      fontSize: '11px',
      color: '#e9c46a',
    });
    container.add(hintText);
    objects.push(hintText);
  }

  return objects;
}
