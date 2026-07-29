/**
 * QuartermasterUI — Floor 2 settlement purchase panel.
 *
 * Presents the player-facing merchant surface for `floorExtendedState.settlement.
 * quartermasterStock`. Stock is generated at floor-load time by
 * `quartermaster-stock.ts`; purchase logic is `quartermaster-purchase.ts`.
 *
 * Pattern: mirrors BossChestUI — a Phaser container panel with toggle/refresh/
 * destroy API, signature-based dirty checking, and a resize handler. Does NOT
 * use RewardOpeningUI (purchases have no reveal sequence).
 *
 * Rarity cues are conveyed as labelled text (not colour alone), satisfying the
 * shared item-presentation contract: keyboard + pointer + touch parity, focus
 * management (per-offer Buy button, disabled visually when unpurchasable),
 * readable rarity labels, and deterministic item details.
 *
 * Layer note: imports only from core + shared (never game/labs), mirroring
 * BossChestUI / AchievementsUI.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { fitUiScale } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import {
  getQuartermasterOfferViews,
  purchaseQuartermasterOffer,
  type QuartermasterOfferView,
} from '../core/quartermaster-purchase.js';
import type { GeneratedEquipmentRarity } from '../shared/generated-equipment-types.js';

const PANEL_PADDING = 16;
const FONT_FAMILY = 'Segoe UI, Arial, sans-serif';
const ROW_HEIGHT = 72;
const ROW_GAP = 8;
const HEADER_HEIGHT = 48;

const COLORS = {
  panelBg: 0x0d0d1a,
  panelBorder: 0x2a2a4a,
  rowBg: 0x15152a,
  rowBorder: 0x333355,
  rowBgSoldOut: 0x111118,
  textPrimary: 0xf8fafc,
  textSecondary: 0x9ca3af,
  textDisabled: 0x4b5563,
  goldColor: 0xfbbf24,
  btnBg: 0x1e4620,
  btnHover: 0x276c2b,
  btnDisabledBg: 0x2a2a3a,
  rarityCommon: 0x9e9e9e,
  rarityUncommon: 0x4caf50,
  rarityRare: 0x2196f3,
} as const;

function hex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function rarityLabel(rarity: GeneratedEquipmentRarity): string {
  switch (rarity) {
    case 'common':
      return '[Common]';
    case 'uncommon':
      return '[Uncommon]';
    case 'rare':
      return '[Rare]';
  }
}

function rarityColor(rarity: GeneratedEquipmentRarity): number {
  switch (rarity) {
    case 'common':
      return COLORS.rarityCommon;
    case 'uncommon':
      return COLORS.rarityUncommon;
    case 'rare':
      return COLORS.rarityRare;
  }
}

function offerSignature(offers: readonly QuartermasterOfferView[]): string {
  return offers
    .map(
      (o) =>
        `${o.offerId}:${o.quantity}:${o.affordable}:${o.capacityAvailable}:${o.canPurchase}`,
    )
    .join('|');
}

function goldSignature(world: GameWorld): string {
  return String(world.playerGold);
}

export interface QuartermasterUIConfig {
  width?: number;
  height?: number;
  /** Resolves the entity that receives purchased equipment. */
  getPlayerEid: () => number | undefined;
  /**
   * Called after every completed purchase attempt so the caller can refresh
   * other dependent UI (inventory, equipment panel, HUD gold display, etc.).
   */
  onPurchaseResult?: (result: { ok: boolean; reason?: string; goldSpent?: number }) => void;
}

export interface QuartermasterUIApi {
  toggle(world: GameWorld): void;
  refresh(world: GameWorld): void;
  isOpen(): boolean;
  destroy(): void;
}

export function createQuartermasterUI(
  scene: Phaser.Scene,
  config: QuartermasterUIConfig,
): QuartermasterUIApi {
  const snap = (value: number): number => Math.round(value);
  const baseResolution = getRenderScale(scene);
  let textResolution = baseResolution;
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const panelWidth = config.width ?? 560;
  const panelHeight = config.height ?? 440;

  let uiScale = fitUiScale(scene, panelWidth, panelHeight);
  textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  let visible = false;
  let lastWorld: GameWorld | null = null;
  let lastSignature: string | null = null;

  const container = scene.add.container(0, 0).setDepth(1000).setVisible(false);

  let panelX = snap((viewWidth() - panelWidth) / 2);
  let panelY = snap((viewHeight() - panelHeight) / 2);

  const bg = scene.add.rectangle(0, 0, panelWidth, panelHeight, COLORS.panelBg, 0.96);
  bg.setStrokeStyle(2, COLORS.panelBorder);
  container.add(bg);

  const title = crispText(0, 0, '🛒 QUARTERMASTER', {
    fontFamily: FONT_FAMILY,
    fontSize: '20px',
    color: hex(COLORS.textPrimary),
  });
  container.add(title);

  const hint = crispText(0, 0, '[Q] to close', {
    fontFamily: FONT_FAMILY,
    fontSize: '12px',
    color: hex(COLORS.textSecondary),
  });
  hint.setOrigin(1, 0);
  container.add(hint);

  const goldLabel = crispText(0, 0, '', {
    fontFamily: FONT_FAMILY,
    fontSize: '14px',
    color: hex(COLORS.goldColor),
  });
  container.add(goldLabel);

  const rowObjects: Phaser.GameObjects.GameObject[] = [];

  function clearRows(): void {
    for (const obj of rowObjects) obj.destroy();
    rowObjects.length = 0;
  }

  function computeSignature(world: GameWorld, playerEid: number): string {
    const offers = getQuartermasterOfferViews(world, playerEid);
    return `${offerSignature(offers)}::${goldSignature(world)}`;
  }

  function makeRow(
    world: GameWorld,
    playerEid: number,
    offer: QuartermasterOfferView,
    x: number,
    y: number,
    w: number,
  ): void {
    const soldOut = offer.quantity === 0;
    const boxColor = soldOut ? COLORS.rowBgSoldOut : COLORS.rowBg;

    const box = scene.add.rectangle(x + w / 2, y + ROW_HEIGHT / 2, w, ROW_HEIGHT, boxColor, 0.9);
    box.setStrokeStyle(1, COLORS.rowBorder);
    container.add(box);
    rowObjects.push(box);

    // Item name + rarity label (rarity label uses distinct text color, not color alone)
    const rarity = offer.utility?.rarity ?? 'common';
    const nameColor = soldOut ? COLORS.textDisabled : COLORS.textPrimary;
    const itemName = offer.displayName ?? offer.offerId;
    const nameText = crispText(x + 12, y + 8, itemName, {
      fontFamily: FONT_FAMILY,
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(nameColor),
    });
    container.add(nameText);
    rowObjects.push(nameText);

    const rarityText = crispText(
      x + 12 + (nameText.width + 8),
      y + 10,
      rarityLabel(rarity),
      {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: soldOut ? hex(COLORS.textDisabled) : hex(rarityColor(rarity)),
      },
    );
    container.add(rarityText);
    rowObjects.push(rarityText);

    // Item level and stat summary
    const utilityParts: string[] = [];
    if (offer.utility) {
      utilityParts.push(`Lvl ${offer.utility.itemLevel}`);
      const slots = offer.utility.slots.join(', ');
      if (slots) utilityParts.push(`Slot: ${slots}`);
    }
    const utilityLine = utilityParts.join(' · ');
    if (utilityLine) {
      const utilText = crispText(x + 12, y + 30, utilityLine, {
        fontFamily: FONT_FAMILY,
        fontSize: '11px',
        color: hex(soldOut ? COLORS.textDisabled : COLORS.textSecondary),
      });
      container.add(utilText);
      rowObjects.push(utilText);
    }

    // Price
    const priceColor = soldOut
      ? COLORS.textDisabled
      : offer.affordable
        ? COLORS.goldColor
        : 0xef4444;
    const priceText = crispText(x + 12, y + 48, `${offer.unitPrice}g`, {
      fontFamily: FONT_FAMILY,
      fontSize: '13px',
      fontStyle: 'bold',
      color: hex(priceColor),
    });
    container.add(priceText);
    rowObjects.push(priceText);

    // Buy button
    if (!soldOut) {
      const canBuy = offer.canPurchase;
      const btnColor = canBuy ? COLORS.btnBg : COLORS.btnDisabledBg;
      const btnTextColor = canBuy ? COLORS.textPrimary : COLORS.textDisabled;
      const btnLabel = canBuy ? 'Buy' : unavailableLabel(offer);
      const btn = crispText(x + w - 12, y + ROW_HEIGHT / 2, btnLabel, {
        fontFamily: FONT_FAMILY,
        fontSize: '13px',
        fontStyle: 'bold',
        color: hex(btnTextColor),
        backgroundColor: hex(btnColor),
        padding: { x: 10, y: 6 },
      });
      btn.setOrigin(1, 0.5);
      if (canBuy) {
        btn
          .setInteractive({ useHandCursor: true })
          .on('pointerover', () => btn.setBackgroundColor(hex(COLORS.btnHover)))
          .on('pointerout', () => btn.setBackgroundColor(hex(btnColor)))
          .on('pointerdown', () => {
            const result = purchaseQuartermasterOffer(world, playerEid, {
              stockId: offer.stockId,
              offerId: offer.offerId,
              quantity: 1,
            });
            lastSignature = null;
            refresh(world);
            if (result.ok) {
              config.onPurchaseResult?.({
                ok: true,
                goldSpent: result.goldSpent,
              });
            } else {
              config.onPurchaseResult?.({ ok: false, reason: result.reason });
            }
          });
      }
      container.add(btn);
      rowObjects.push(btn);
    } else {
      const soldOutText = crispText(x + w - 12, y + ROW_HEIGHT / 2, 'Sold out', {
        fontFamily: FONT_FAMILY,
        fontSize: '12px',
        color: hex(COLORS.textDisabled),
      });
      soldOutText.setOrigin(1, 0.5);
      container.add(soldOutText);
      rowObjects.push(soldOutText);
    }
  }

  function unavailableLabel(offer: QuartermasterOfferView): string {
    switch (offer.purchaseFailure) {
      case 'insufficient-funds':
        return 'No gold';
      case 'inventory-capacity':
        return 'Inv. full';
      default:
        return 'N/A';
    }
  }

  function render(world: GameWorld, playerEid: number): void {
    clearRows();
    const offers = getQuartermasterOfferViews(world, playerEid);

    goldLabel
      .setText(`Gold: ${world.playerGold}g`)
      .setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING + 28)
      .setResolution(textResolution);

    const x = panelX + PANEL_PADDING;
    const w = panelWidth - PANEL_PADDING * 2;

    if (offers.length === 0) {
      const empty = crispText(x, panelY + PANEL_PADDING + HEADER_HEIGHT + 12, 'No items in stock.', {
        fontFamily: FONT_FAMILY,
        fontSize: '14px',
        color: hex(COLORS.textSecondary),
      });
      container.add(empty);
      rowObjects.push(empty);
      return;
    }

    let currentY = panelY + PANEL_PADDING + HEADER_HEIGHT;
    for (const offer of offers) {
      makeRow(world, playerEid, offer, x, currentY, w);
      currentY += ROW_HEIGHT + ROW_GAP;
    }
  }

  function applyLayout(): void {
    uiScale = fitUiScale(scene, panelWidth, panelHeight);
    textResolution = Math.max(1, Math.round(baseResolution * uiScale));
    container.setScale(uiScale);
    panelX = snap((viewWidth() - panelWidth) / 2);
    panelY = snap((viewHeight() - panelHeight) / 2);
    bg.setPosition(panelX + panelWidth / 2, panelY + panelHeight / 2);
    title.setPosition(panelX + PANEL_PADDING, panelY + PANEL_PADDING).setResolution(textResolution);
    hint
      .setPosition(panelX + panelWidth - PANEL_PADDING, panelY + PANEL_PADDING + 2)
      .setResolution(textResolution);
    goldLabel.setResolution(textResolution);
    if (visible) lastSignature = null;
  }

  function refresh(world: GameWorld): void {
    lastWorld = world;
    if (!visible) return;
    const playerEid = config.getPlayerEid();
    if (playerEid === undefined || playerEid < 0) return;
    const signature = computeSignature(world, playerEid);
    if (signature !== lastSignature) {
      render(world, playerEid);
      lastSignature = signature;
    }
  }

  function toggle(world: GameWorld): void {
    visible = !visible;
    container.setVisible(visible);
    if (visible) {
      applyLayout();
      lastSignature = null;
      refresh(world);
    }
  }

  scene.scale.on('resize', applyLayout);

  return {
    toggle,
    refresh,
    isOpen: () => visible,
    destroy() {
      scene.scale.off('resize', applyLayout);
      clearRows();
      container.destroy();
    },
  };
}
