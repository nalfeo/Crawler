/**
 * Locks the player's on-screen size to the welcome-room NPCs' on-screen size.
 *
 * The two entities are sized by completely different mechanisms, which is
 * exactly why this drifts silently:
 *
 *   - **Welcome-room NPCs** are sized in *world feet*. `PhaserBridge` renders
 *     them height-authoritatively via `setScale(ftToPx(heightFt) / nativeH)`,
 *     so their drawn height is `heightFt * PIXELS_PER_FOOT` regardless of the
 *     source art's pixel dimensions.
 *   - **The player** is sized in *source pixels*: its drawn height is the
 *     generated sprite's native frame height multiplied by the
 *     `renderKinds.player.generated.scale` factor in
 *     `entity-sprite-mappings.json`.
 *
 * Nothing structurally ties those two numbers together, so re-generating the
 * player art at a different frame size, or re-authoring the welcome-room NPC
 * anchors, would silently break the match with no test failure. This guard
 * recomputes both from their real sources and asserts they agree.
 *
 * If this fails after intentionally changing player art, fix
 * `renderKinds.player.generated.scale` to `ftToPx(npcHeightFt) / frameHeight`
 * rather than relaxing the assertion.
 */
import { describe, expect, it } from 'vitest';

import PLAYER_WALK_SHARD from '../../public/assets/generated/entries/player-walk-cycle-female.json';
import ENTITY_SPRITE_MAPPINGS from '../../src/shared/data/entity-sprite-mappings.json';
import SET_PIECES from '../../src/shared/data/set-pieces.json';
import { ftToPx } from '../../src/shared/units.js';

const WELCOME_ROOM_ID = 'welcome-room';

interface SetPieceNpc {
  readonly id: string;
  readonly heightFt?: number;
}

function welcomeRoomNpcs(): readonly SetPieceNpc[] {
  const { setPieces } = SET_PIECES as {
    readonly setPieces: ReadonlyArray<{
      readonly id: string;
      readonly npcs?: readonly SetPieceNpc[];
    }>;
  };
  const welcomeRoom = setPieces.find((piece) => piece.id === WELCOME_ROOM_ID);
  expect(welcomeRoom, `set-pieces.json is missing the '${WELCOME_ROOM_ID}' piece`).toBeDefined();
  const npcs = welcomeRoom?.npcs ?? [];
  expect(npcs.length, 'welcome-room should declare at least one NPC').toBeGreaterThan(0);
  return npcs;
}

describe('player / welcome-room NPC scale parity', () => {
  it('renders every welcome-room NPC at the same height', () => {
    const heights = new Set(welcomeRoomNpcs().map((npc) => npc.heightFt));
    // The parity assertion below compares against a single NPC height, so it
    // is only meaningful while the welcome-room cast is uniformly sized.
    expect(heights.size, `welcome-room NPCs have mixed heights: ${[...heights].join(', ')}`).toBe(
      1,
    );
  });

  it('renders the player at the same pixel height as the welcome-room NPCs', () => {
    const npcHeightFt = welcomeRoomNpcs()[0]?.heightFt;
    expect(npcHeightFt, 'welcome-room NPCs must declare heightFt').toBeTypeOf('number');
    const npcHeightPx = ftToPx(npcHeightFt as number);

    const playerGenerated = ENTITY_SPRITE_MAPPINGS.renderKinds.player.generated;
    const playerFrameHeight = PLAYER_WALK_SHARD.animation.frameHeight;
    const playerHeightPx = playerFrameHeight * playerGenerated.scale;

    expect(playerHeightPx).toBeCloseTo(npcHeightPx, 5);
  });

  it('pins the player to the generated walk-cycle art that this guard measures', () => {
    // The parity math above reads the frame height out of the walk-cycle
    // shard, so it only describes reality while the player is actually wired
    // to that shard.
    const playerGenerated = ENTITY_SPRITE_MAPPINGS.renderKinds.player.generated;
    expect(playerGenerated.briefId).toBe(PLAYER_WALK_SHARD.briefId);
    expect(playerGenerated.pinnedTextureKey).toBe(PLAYER_WALK_SHARD.spriteName);
  });
});
