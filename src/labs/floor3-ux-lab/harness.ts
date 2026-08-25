/**
 * Shared Phaser harness for the five Floor-3 UX labs.
 *
 * Each surface gets its own registered lab (game-design §15 lists them as
 * separate surfaces); they all mount the *real* `HudUI` — and therefore the
 * real `HudFloor3Party` widget — over the shared fixture world, so a lab shows
 * exactly what the game renders.
 *
 * Rule #9/#10 note: these labs are not sufficient validation on their own. The
 * party HUD is also created inside `HudUI` (mounted by `MainGameScene`), and
 * the roster/command verbs are bound in `MainGameScene`.
 */
import GUI from 'lil-gui';
import Phaser from 'phaser';
import { GAME } from '../../shared/constants.js';
import { createHudUI } from '../../engine/HudUI.js';
import { createFloor3RosterUI } from '../../engine/Floor3RosterUI.js';
import type { HudFloor3PartyState } from '../../engine/HudFloor3Party.js';
import type { Floor3RosterState } from '../../engine/Floor3RosterUI.js';
import { speciesTokenForId } from '../../shared/data/floor3/species.js';
import { createFloor3LabFixture, type Floor3LabFixture } from './fixture.js';

/**
 * Deterministic probe the Floor-3 UX e2e tests drive. Every mutation is an
 * explicit call plus an explicit HUD sync — no timers, no `Date.now()`.
 */
export interface Floor3UxProbeApi {
  ready(): boolean;
  getPartyState(): HudFloor3PartyState;
  getRosterState(): Floor3RosterState;
  setHp(slot: number, hp: number): void;
  setLevel(slot: number, level: number): void;
  setKnockedOut(slot: number, knockedOut: boolean): void;
  setPlayerLevel(level: number): void;
  setRivalSpecies(speciesId: string): void;
  setRivalDistanceFt(distanceFt: number): void;
  command(slot?: number): { accepted: boolean; detail: string };
  advanceFrames(count: number): void;
  openRoster(): void;
  moveRosterCursor(delta: number): void;
  closeRoster(): void;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

export interface Floor3UxLabContext {
  fixture: Floor3LabFixture;
  hudUi: ReturnType<typeof createHudUI>;
  rosterUi: ReturnType<typeof createFloor3RosterUI>;
  /** Advance the deterministic frame counter (no `Date.now()` anywhere). */
  advanceFrames(count: number): void;
  refresh(): void;
}

export interface Floor3UxLabConfig {
  /** Copy shown under the canvas describing what this surface proves. */
  legend: string;
  /** Build the lil-gui controls once the scene is live. */
  buildControls(gui: GUI, ctx: Floor3UxLabContext): void;
  /** Open the roster overlay as soon as the lab boots. */
  openRoster?: boolean;
}

export function createFloor3UxLab(
  config: Floor3UxLabConfig,
): (canvasHost: HTMLElement, controls: HTMLElement) => () => void {
  return (canvasHost: HTMLElement, controls: HTMLElement): (() => void) => {
    const labGui = (controls as ControlsWithGui).__labGui;
    if (!(labGui instanceof GUI)) {
      throw new Error('Lab runner did not initialize lil-gui.');
    }
    const gui: GUI = labGui;

    const root = document.createElement('div');
    root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;';
    canvasHost.append(root);
    const gameHost = document.createElement('div');
    gameHost.style.cssText = 'width:100%;height:100%;';
    root.append(gameHost);

    const legend = document.createElement('div');
    legend.style.cssText =
      'margin-top:16px;color:#c9d4ff;line-height:1.6;font-family:monospace;font-size:12px;';
    legend.textContent = config.legend;
    controls.append(legend);

    const fixture = createFloor3LabFixture();
    let hudUi: ReturnType<typeof createHudUI> | undefined;
    let rosterUi: ReturnType<typeof createFloor3RosterUI> | undefined;
    let sceneReady = false;
    const probeWindow = window as unknown as {
      __uiProbe?: { ready(): boolean };
      __floor3UxProbe?: Floor3UxProbeApi;
    };

    class Floor3UxLabScene extends Phaser.Scene {
      constructor() {
        super({ key: 'Floor3UxLabScene' });
      }

      create(): void {
        this.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, 0x05070f).setOrigin(0, 0);
        const hud = createHudUI(this);
        const roster = createFloor3RosterUI(this);
        hudUi = hud;
        rosterUi = roster;

        const ctx: Floor3UxLabContext = {
          fixture,
          hudUi: hud,
          rosterUi: roster,
          advanceFrames(count: number): void {
            fixture.world.frameCount += Math.max(0, Math.floor(count));
            ctx.refresh();
          },
          refresh(): void {
            hud.sync(fixture.world, fixture.playerEid);
            roster.sync(fixture.world);
          },
        };

        if (config.openRoster === true) roster.open(fixture.world);
        config.buildControls(gui, ctx);
        ctx.refresh();
        sceneReady = true;
        probeWindow.__uiProbe = { ready: () => sceneReady };
        const eidForSlot = (slot: number): number | undefined => fixture.partyEids[slot];
        probeWindow.__floor3UxProbe = {
          ready: () => sceneReady,
          getPartyState: () => hud.getFloor3PartyState(),
          getRosterState: () => roster.getState(),
          setHp(slot, hp) {
            const eid = eidForSlot(slot);
            if (eid === undefined) return;
            fixture.world.stores.health.current[eid] = hp;
            ctx.refresh();
          },
          setLevel(slot, level) {
            const eid = eidForSlot(slot);
            if (eid === undefined) return;
            fixture.world.stores.companion.level[eid] = level;
            ctx.refresh();
          },
          setKnockedOut(slot, knockedOut) {
            const eid = eidForSlot(slot);
            if (eid === undefined) return;
            fixture.world.stores.companion.knockedOut[eid] = knockedOut ? 1 : 0;
            ctx.refresh();
          },
          setPlayerLevel(level) {
            fixture.world.playerLevel.level = level;
            ctx.refresh();
          },
          setRivalSpecies(speciesId) {
            fixture.world.stores.companion.speciesToken[fixture.rivalEid] =
              speciesTokenForId(speciesId);
            ctx.refresh();
          },
          setRivalDistanceFt(distanceFt) {
            fixture.world.stores.position.x[fixture.rivalEid] = distanceFt;
            ctx.refresh();
          },
          command(slot) {
            const result = hud.issueFloor3Command(fixture.world, fixture.playerEid, slot);
            ctx.refresh();
            return {
              accepted: result.accepted,
              detail: result.accepted ? result.abilityName : result.rejection,
            };
          },
          advanceFrames: (count) => ctx.advanceFrames(count),
          openRoster: () => {
            roster.open(fixture.world);
          },
          moveRosterCursor: (delta) => {
            roster.moveCursor(fixture.world, delta);
          },
          closeRoster: () => {
            roster.close();
          },
        };

        this.events.once('shutdown', () => {
          sceneReady = false;
          if (probeWindow.__uiProbe) delete probeWindow.__uiProbe;
          if (probeWindow.__floor3UxProbe) delete probeWindow.__floor3UxProbe;
        });
      }

      update(): void {
        if (!hudUi || !rosterUi) return;
        hudUi.sync(fixture.world, fixture.playerEid);
        rosterUi.sync(fixture.world);
      }
    }

    const game = new Phaser.Game({
      type: Phaser.AUTO,
      parent: gameHost,
      width: GAME.WIDTH,
      height: GAME.HEIGHT,
      backgroundColor: '#05070f',
      scene: [Floor3UxLabScene],
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });

    return () => {
      rosterUi?.destroy();
      hudUi?.destroy();
      game.destroy(true);
      legend.remove();
      root.remove();
    };
  };
}
