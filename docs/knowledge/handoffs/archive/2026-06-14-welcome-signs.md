# Floor 1 Welcome Signs

## What was done

- Added `findRoomPath` BFS in `floor1Scenario.ts` to compute the shortest room-to-room path from the spawn room to the safe room (welcome guild).
- Added logic in `initializeFloor1Scenario` to spawn "welcome sign" entities along that path (spaced every other room) with correct rotation pointing to the next room in the path.
- Updated `PhaserBridge.ts` procedural texture generator to create `TEX_WELCOME_SIGN`, a hand-painted wooden sign with a white arrow.
- Updated `PhaserBridge.ts` entity type resolution to recognize `Sprite` components with `textureId: 3` as `welcome_sign`.
- Adjusted `PhaserBridge.ts` rendering to respect the `Rotation` component if present on `welcome_sign` entities.

## Apple Estimate

🍎🍎 (2 apples)
Actuals: 🍎🍎
Verdict: Accurate. Implemented procedural rendering + BFS logic efficiently.

## Next steps

- Potentially update procedural textures to actual sprite sheets once the art pipeline supports environment/sign sprites.
