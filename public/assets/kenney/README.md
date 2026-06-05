# Kenney CC0 Sprite Assets

The contents of this directory are sourced from Kenney's free CC0
asset packs. CC0 (Creative Commons Zero) means no attribution is
required and the assets may be used in personal and commercial
projects without restriction.

We include each upstream `LICENSE.txt` for traceability anyway.

## Refreshing

Run `bash scripts/fetch-assets.sh` from the repository root. The
script is idempotent and verifies the SHA-256 of every download
before writing into the repo.

## Packs

| Pack                 | Source URL                                    | Sheet   | Tiles      | Notes                                              |
| -------------------- | --------------------------------------------- | ------- | ---------- | -------------------------------------------------- |
| roguelike-characters | https://kenney.nl/assets/roguelike-characters | 918×203 | 54×12      | Characters + equipment.                            |
| tiny-dungeon         | https://kenney.nl/assets/tiny-dungeon         | 203×186 | 12×11=132  | Dungeon characters, weapons, items, projectiles.   |
| tiny-town            | https://kenney.nl/assets/tiny-town            | 203×186 | 12×11=132  | Outdoor terrain, buildings, trees, NPCs, animals.  |
| tiny-battle          | https://kenney.nl/assets/tiny-battle          | 305×186 | 18×11=198  | Soldiers, vehicles, military props.                |
| tiny-ski             | https://kenney.nl/assets/tiny-ski             | 203×186 | 12×11=132  | Winter biome.                                      |
| roguelike-rpg-pack   | https://kenney.nl/assets/roguelike-rpg-pack   | 968×526 | 57×31≈1767 | Floors, walls, roofs, flora, doors, furniture, UI. |

All packs share a unified hand-drawn 16×16 aesthetic with 1px tile
spacing — they mix freely in the same scene. Use the `tile-explorer`
lab (`?lab=tile-explorer`) to browse every tile and copy frame indices.
