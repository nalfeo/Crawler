import Phaser from 'phaser';
import type { ScenarioConstructionSnapshot } from '../shared/scenario-presentation.js';
import { ftToPx } from '../shared/units.js';

const TOWER_STYLES: Record<string, { color: number; glyph: string }> = {
  'signal-slinger': { color: 0x67e8f9, glyph: 'S' },
  'relay-riveter': { color: 0xfbbf24, glyph: 'R' },
  'crane-caster': { color: 0xc4b5fd, glyph: 'C' },
};

/** Presentation only: all geometry, occupancy, and health come from the scenario. */
export class ConstructionWorldUI {
  private readonly ground: Phaser.GameObjects.Graphics;
  private readonly labels = new Map<string, Phaser.GameObjects.Text>();
  private lastGeometry = '';
  private readonly targets = new Map<string, string>();

  constructor(private readonly scene: Phaser.Scene) {
    this.ground = scene.add.graphics().setDepth(-1);
  }

  sync(snapshot: ScenarioConstructionSnapshot | null, selectedSiteId: string | null): void {
    this.ground.setVisible(snapshot !== null);
    if (!snapshot) {
      for (const label of this.labels.values()) label.setVisible(false);
      this.lastGeometry = '';
      this.targets.clear();
      return;
    }
    // The bridge owns entity lifetime. Replace its generic fallback with a
    // procedural presentation texture after sync, without writing any ECS data.
    for (const site of snapshot.sites) {
      if (!site.tower) continue;
      const tower = site.tower;
      const style = TOWER_STYLES[tower.towerId] ?? { color: 0xffffff, glyph: 'T' };
      const textureKey = `construction-${tower.towerId}`;
      if (!this.scene.textures.exists(textureKey)) {
        const art = this.scene.add.graphics();
        art.fillStyle(0x101827).fillRect(4, 36, 56, 24);
        art.lineStyle(3, style.color).strokeRect(4, 36, 56, 24);
        art.fillStyle(style.color);
        if (style.glyph === 'S') {
          art.fillTriangle(32, 4, 12, 38, 52, 38);
          art.lineStyle(4, 0xffffff).strokeCircle(32, 20, 9);
        } else if (style.glyph === 'R') {
          art.fillRect(18, 8, 28, 36);
          art.fillRect(10, 12, 44, 10);
        } else {
          art.fillRect(12, 8, 8, 40);
          art.fillRect(12, 8, 44, 8);
          art.lineStyle(3, style.color).lineBetween(50, 16, 50, 35);
          art.strokeCircle(50, 39, 5);
        }
        art.generateTexture(textureKey, 64, 64);
        art.destroy();
      }
      const sprite = this.scene.children.getByName(`floor6-tower:${tower.eid}`);
      if (sprite instanceof Phaser.GameObjects.Image) {
        sprite.setTexture(textureKey).setDisplaySize(ftToPx(7), ftToPx(7));
      }
    }
    const geometry = JSON.stringify([
      snapshot.sites,
      snapshot.relay,
      snapshot.routes,
      selectedSiteId,
    ]);
    if (geometry === this.lastGeometry) return;
    this.lastGeometry = geometry;
    this.targets.clear();
    this.targets.set('relay', '__relay__');
    for (const site of snapshot.sites) this.targets.set(site.siteId, site.siteId);
    const g = this.ground.clear();
    const liveLabels = new Set<string>();
    const label = (id: string, x: number, y: number, text: string, color = '#e0f2fe') => {
      liveLabels.add(id);
      let node = this.labels.get(id);
      if (!node) {
        node = this.scene.add
          .text(x, y, text, {
            fontFamily: 'monospace',
            fontSize: '14px',
            fontStyle: 'bold',
            backgroundColor: '#101827dd',
            padding: { x: 5, y: 3 },
            align: 'center',
          })
          .setOrigin(0.5)
          .setDepth(2)
          .setName(`construction-label:${id}`);
        this.labels.set(id, node);
      }
      node.setPosition(x, y).setText(text).setColor(color).setVisible(true);
    };
    for (const route of snapshot.routes) {
      for (let i = 1; i < route.pointsFt.length; i++) {
        const a = route.pointsFt[i - 1]!;
        const b = route.pointsFt[i]!;
        const ax = ftToPx(a.x),
          ay = ftToPx(a.y),
          bx = ftToPx(b.x),
          by = ftToPx(b.y);
        g.lineStyle(3, 0xfbbf24, 0.45).lineBetween(ax, ay, bx, by);
        const length = Math.hypot(bx - ax, by - ay);
        const dx = (bx - ax) / length,
          dy = (by - ay) / length;
        for (let distance = 32; distance < length; distance += 96) {
          const x = ax + dx * distance,
            y = ay + dy * distance;
          g.lineStyle(3, 0xfbbf24, 0.8);
          g.lineBetween(x - dx * 9 - dy * 6, y - dy * 9 + dx * 6, x, y);
          g.lineBetween(x - dx * 9 + dy * 6, y - dy * 9 - dx * 6, x, y);
        }
      }
      const start = route.pointsFt[0];
      if (start) label(route.id, ftToPx(start.x), ftToPx(start.y) - 32, route.label, '#fde68a');
    }
    for (const site of snapshot.sites) {
      const { x, y, width, height } = site.boundsFt;
      const cx = ftToPx(x + width / 2),
        cy = ftToPx(y + height / 2);
      const style = site.tower ? TOWER_STYLES[site.tower.towerId] : undefined;
      const color = style?.color ?? 0x67e8f9;
      g.fillStyle(0x102839, 0.8).fillRect(ftToPx(x), ftToPx(y), ftToPx(width), ftToPx(height));
      g.lineStyle(3, color).strokeRect(ftToPx(x), ftToPx(y), ftToPx(width), ftToPx(height));
      if (!site.tower) {
        g.lineStyle(3, color).lineBetween(cx - 10, cy, cx + 10, cy);
        g.lineBetween(cx, cy - 10, cx, cy + 10);
      }
      const shortSite = site.siteId.replace('plinth-', '').toUpperCase();
      label(
        site.siteId,
        cx,
        ftToPx(y) - 24,
        site.tower
          ? `${style?.glyph ?? 'T'} · ${site.tower.label}\n${site.tower.roleLabel}\n${shortSite} · Tap to inspect`
          : `${shortSite} · Tap to build`,
      );
      if (site.tower && selectedSiteId === site.siteId) {
        g.lineStyle(2, color, 0.8).strokeCircle(cx, cy, ftToPx(site.tower.rangeFt));
        label('range', cx, cy - ftToPx(site.tower.rangeFt) - 12, `${site.tower.rangeFt} ft range`);
      }
    }
    const relay = snapshot.relay;
    const rx = ftToPx(relay.positionFt.x),
      ry = ftToPx(relay.positionFt.y);
    g.fillStyle(0x102839).fillCircle(rx, ry, 30);
    g.lineStyle(4, 0x86efac).strokeCircle(rx, ry, 30);
    g.lineStyle(5, 0xe0f2fe).lineBetween(rx, ry + 18, rx, ry - 30);
    g.strokeCircle(rx, ry - 30, 10);
    g.lineStyle(3, 0x86efac).strokeCircle(rx, ry - 30, 20);
    label(
      'relay',
      rx,
      ry - 80,
      `${relay.label}\n${relay.hp}/${relay.maxHp} HP · Tap for upgrades`,
      '#bbf7d0',
    );
    for (const [id, node] of this.labels) node.setVisible(liveLabels.has(id));
  }

  destroy(): void {
    this.ground.destroy();
    for (const node of this.labels.values()) node.destroy();
    this.labels.clear();
  }

  /** Labels advertise taps too, so their full displayed bounds share the target. */
  getTargetAt(worldX: number, worldY: number): string | null {
    for (const [id, target] of this.targets) {
      const label = this.labels.get(id);
      if (label?.visible && label.getBounds().contains(worldX, worldY)) return target;
    }
    return null;
  }
}
