import { entityExists } from 'bitecs';
import { describe, expect, it } from 'vitest';
import { createFloorMainSceneOptions } from '../../src/bootstrap/floor-main-scene-options.js';
import { spawnPlayer } from '../../src/core/helpers.js';
import { floor6DefenseDirectorSystem } from '../../src/game/floor6Scenario.js';
import { floor6Manifest } from '../../src/shared/floor-manifest.js';
import type { Floor6DefensePhaseKind } from '../../src/shared/floor-types.js';
import { createTestWorld } from '../helpers/world-factory.js';

function setup() {
  const world = createTestWorld({ seed: 606 });
  const player = spawnPlayer(world, 0, 0);
  const options = createFloorMainSceneOptions('floor6');
  options.configureWorld!(world, player);
  world.frameCount += 1;
  world.elapsedMs += 16;
  floor6DefenseDirectorSystem(world);
  const state = world.floorExtendedState!.floor6Defense!;
  const construction = options.scenarioPresentation!.construction!;
  return { world, state, construction, siteId: state.geometry.buildSites[0]!.id };
}

describe('Floor 6 player construction contract', () => {
  it('supports inspect and sell through the same authoritative scene seam as build', () => {
    const { world, state, construction, siteId } = setup();
    state.economy.balance = 10;
    const built = construction.requestBuild(world, siteId, 'signal-slinger');
    expect(built.ok).toBe(true);
    const site = construction.getSnapshot(world)!.sites.find((entry) => entry.siteId === siteId)!;
    expect(site).toMatchObject({
      occupied: true,
      tower: {
        eid: built.eid,
        towerId: 'signal-slinger',
        label: 'Signal Slinger',
        rangeFt: 36,
        sellRefund: 1,
        tierLabel: 'base tier',
      },
    });
    expect(construction.requestBuild(world, siteId, 'signal-slinger')).toEqual({
      ok: false,
      reason: 'occupied',
    });
    expect(state.economy.balance).toBe(8);
    expect(construction.requestSell(world, siteId)).toEqual({ ok: true, reason: 'sold' });
    expect(state.economy.balance).toBe(9);
    expect(entityExists(world.ecs, built.eid!)).toBe(false);
    expect(
      construction.getSnapshot(world)!.sites.find((entry) => entry.siteId === siteId),
    ).toMatchObject({
      occupied: false,
    });
    expect(
      construction.getSnapshot(world)!.sites.find((entry) => entry.siteId === siteId)!.tower,
    ).toBeUndefined();
    expect(construction.requestSell(world, siteId)).toEqual({ ok: false, reason: 'vacant' });
    expect(state.economy.balance).toBe(9);
  });

  it('projects purchase state immediately and rejects duplicate or unaffordable requests', () => {
    const { world, state, construction } = setup();
    const offer = construction.getSnapshot(world)!.upgrades[0]!;
    expect(offer).toMatchObject({ selected: false, affordable: false });
    expect(construction.requestUpgrade(world, offer.offerId)).toEqual({
      ok: false,
      reason: 'unaffordable',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.selectedOfferIds).toEqual([]);
    state.economy.balance = offer.cost;
    expect(construction.getSnapshot(world)!.upgrades[0]!.affordable).toBe(true);
    expect(construction.requestUpgrade(world, offer.offerId)).toEqual({
      ok: true,
      reason: 'purchased',
    });
    expect(state.economy.balance).toBe(0);
    expect(construction.getSnapshot(world)!.upgrades[0]).toMatchObject({
      selected: true,
      affordable: false,
    });
    expect(construction.requestUpgrade(world, offer.offerId)).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    expect(construction.requestUpgrade(world, 'missing-offer')).toEqual({
      ok: false,
      reason: 'unknown-offer',
    });
    expect(state.economy.balance).toBe(0);
    expect(state.economy.selectedOfferIds).toEqual([offer.offerId]);
  });

  it.each<Floor6DefensePhaseKind>(['SETUP', 'DEFEND', 'BREAK', 'FINALE', 'VICTORY', 'DEFEAT'])(
    'advertises the same permissions that transactions enforce during %s',
    (kind) => {
      const { world, state, construction, siteId } = setup();
      state.economy.balance = 100;
      construction.requestBuild(world, siteId, 'signal-slinger');
      state.phase = { kind };
      const snapshot = construction.getSnapshot(world)!;
      const expected = kind === 'DEFEND' || kind === 'BREAK';
      expect([snapshot.canBuild, snapshot.canSell, snapshot.canPurchaseUpgrade]).toEqual([
        expected,
        expected,
        expected,
      ]);
      expect(snapshot.sites.find((entry) => entry.siteId === siteId)!.tower).toBeDefined();
      const balanceBefore = state.economy.balance;
      const results = [
        construction.requestBuild(world, state.geometry.buildSites[1]!.id, 'signal-slinger'),
        construction.requestSell(world, siteId),
        construction.requestUpgrade(world, snapshot.upgrades[0]!.offerId),
      ];
      expect(results.map((result) => result.ok)).toEqual([expected, expected, expected]);
      if (!expected) {
        expect(results.map((result) => result.reason)).toEqual([
          'phase-locked',
          'phase-locked',
          'phase-locked',
        ]);
        expect(state.economy.balance).toBe(balanceBefore);
        expect(state.towerInstances).toHaveLength(1);
        expect(state.economy.selectedOfferIds).toEqual([]);
      }
    },
  );

  it('does not mutate simulation state or alias authored geometry when presenting the scene', () => {
    const { world, state, construction, siteId } = setup();
    state.economy.balance = 20;
    construction.requestBuild(world, siteId, 'signal-slinger');
    construction.requestUpgrade(world, construction.getSnapshot(world)!.upgrades[0]!.offerId);
    const before = JSON.stringify({ state, goals: [...world.goalFlags], frame: world.frameCount });
    const snapshot = construction.getSnapshot(world)!;
    expect(construction.getSnapshot(world)).toEqual(snapshot);
    expect(JSON.stringify({ state, goals: [...world.goalFlags], frame: world.frameCount })).toBe(
      before,
    );
    const tileSizeFt = world.floorMap!.config.tileSizeFt;
    const target = state.geometry.broadcastRelay.target;
    expect(snapshot.relay.positionFt).toEqual({
      x: (target.x + 0.5) * tileSizeFt,
      y: (target.y + 0.5) * tileSizeFt,
    });
    expect(snapshot.relay.hp).toBe(state.relayHp);
    for (const [index, route] of state.geometry.routes.entries()) {
      expect(snapshot.routes[index]!.pointsFt).toEqual(
        route.waypoints.map((point) => ({
          x: (point.x + 0.5) * tileSizeFt,
          y: (point.y + 0.5) * tileSizeFt,
        })),
      );
      expect(snapshot.routes[index]!.pointsFt).not.toBe(route.waypoints);
    }
  });

  it('describes global effects without misrepresenting Relay purchases as tower tiers', () => {
    const { world, state, construction, siteId } = setup();
    state.economy.balance = 100;
    state.upgradeOfferManifest = floor6Manifest.floor6!.upgrades!.offers.map(
      (offer, stableIndex) => ({
        offerId: offer.id,
        stableIndex,
        cost: offer.cost,
        effect: offer.effect,
      }),
    );
    construction.requestBuild(world, siteId, 'signal-slinger');
    const maxHp = construction.getSnapshot(world)!.relay.maxHp;
    expect(construction.requestUpgrade(world, 'relay-bracing').ok).toBe(true);
    let snapshot = construction.getSnapshot(world)!;
    expect(snapshot.relay.maxHp).toBe(maxHp + 10);
    expect(snapshot.sites[0]!.tower!.tierLabel).toBe('base tier');
    expect(construction.requestUpgrade(world, 'faster-loader').ok).toBe(true);
    snapshot = construction.getSnapshot(world)!;
    expect(snapshot.sites[0]!.tower!.tierLabel).toBe('+1 global tower modifier');
    expect(
      snapshot.upgrades.find((offer) => offer.offerId === 'faster-loader')!.description,
    ).toContain('cooldowns reduced by 10%');
    expect(
      snapshot.upgrades.find((offer) => offer.offerId === 'spare-batteries')!.description,
    ).toContain('up to its maximum');
    expect(
      snapshot.upgrades.find((offer) => offer.offerId === 'route-sweeper')!.description,
    ).toContain('All towers');
    expect(
      snapshot.upgrades.find((offer) => offer.offerId === 'contractor-decoys')!.description,
    ).toContain('raider movement');
  });
});
