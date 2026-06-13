import { PNG } from 'pngjs';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createEmptyPNG(width: number = 64, height: number = 64) {
  return new PNG({ width, height });
}

// Rich Terraria-style Palette
const C: Record<string, [number, number, number, number]> = {
  ' ': [0, 0, 0, 0],
  X: [24, 20, 37, 255], // Darkest outline
  W: [232, 224, 207, 255], // White highlight
  S: [240, 164, 41, 255], // Skin/Gold
  s: [200, 110, 30, 255], // Skin shadow
  H: [155, 127, 232, 255], // Hair/Purple
  B: [63, 191, 159, 255], // Teal shirt
  P: [58, 49, 80, 255], // Dark pants
  L: [120, 70, 45, 255], // Wood
  l: [70, 35, 25, 255], // Wood shadow
  I: [160, 170, 180, 255], // Iron
  G: [120, 220, 130, 255], // Slime highlight
  g: [50, 160, 80, 255], // Slime base
  d: [30, 100, 50, 255], // Slime dark
  R: [154, 143, 176, 255], // Rat fur (muted)
  r: [100, 80, 90, 255], // Rat shadow
  E: [226, 80, 74, 255], // Red eye
  F: [240, 164, 41, 255], // Fire core
  f: [226, 80, 74, 255], // Fire mid
  e: [150, 40, 40, 255], // Fire edge
};

function pFill(
  png: PNG,
  startX: number,
  startY: number,
  width: number,
  height: number,
  rgba: number[],
) {
  for (let y = startY; y < startY + height; y++) {
    for (let x = startX; x < startX + width; x++) {
      if (x < 0 || x >= png.width || y < 0 || y >= png.height) continue;
      const idx = (png.width * y + x) << 2;
      png.data[idx] = rgba[0]!;
      png.data[idx + 1] = rgba[1]!;
      png.data[idx + 2] = rgba[2]!;
      png.data[idx + 3] = rgba[3]!;
    }
  }
}

function drawAscii(png: PNG, ascii: string[], startX: number, startY: number) {
  for (let y = 0; y < ascii.length; y++) {
    const row = ascii[y];
    if (!row) continue;
    for (let x = 0; x < row.length; x++) {
      const char = row[x];
      if (char && char !== ' ' && C[char]) {
        // native 1x1 pixel mapping
        pFill(png, startX + x, startY + y, 1, 1, C[char] as number[]);
      }
    }
  }
}

function drawFloorOnPng(png: PNG, _variant: number = 0) {
  // Floor tiling strategy: soft, varied 32x32 flagstones with minimal noise
  const baseColor = [
    Math.floor(100 + Math.random() * 10 - 5),
    Math.floor(100 + Math.random() * 10 - 5),
    Math.floor(110 + Math.random() * 10 - 5),
    255,
  ];

  // Fill background
  pFill(png, 0, 0, 64, 64, baseColor);

  // Subtle 32x32 flagstone variations to break the grid but keep noise low
  for (let qy = 0; qy < 2; qy++) {
    for (let qx = 0; qx < 2; qx++) {
      const mod = Math.floor(Math.random() * 8 - 4);
      const qColor = [
        Math.max(0, Math.min(255, baseColor[0]! + mod)),
        Math.max(0, Math.min(255, baseColor[1]! + mod)),
        Math.max(0, Math.min(255, baseColor[2]! + mod)),
        255,
      ];
      pFill(png, qx * 32 + 2, qy * 32 + 2, 28, 28, qColor); // leaves 2px grout edge
    }
  }
}

function drawWallH(png: PNG, _variant: number = 0) {
  // 64x128 wall piece
  // Wall base (perspective)
  for (let y = 80; y < 128; y++) {
    pFill(png, 0, y, 64, 1, [30, 25, 40, 255]);
  }
  // Wall top (ceiling)
  for (let y = 0; y < 80; y++) {
    pFill(png, 0, y, 64, 1, [20, 18, 30, 255]);
  }

  // Add grounding shadow at the very bottom
  pFill(png, 0, 126, 64, 2, [0, 0, 0, 80]);
}

function drawWallV(png: PNG, _variant: number = 0) {
  // 64x128 vertical wall piece
  for (let x = 0; x < 64; x++) {
    pFill(png, x, 0, 1, 128, [20, 18, 30, 255]);
  }
  // Side face
  for (let x = 48; x < 64; x++) {
    pFill(png, x, 80, 1, 48, [30, 25, 40, 255]);
  }
  // Grounding shadow
  pFill(png, 0, 126, 64, 2, [0, 0, 0, 80]);
}

function drawWallCorner(png: PNG, type: string) {
  // Basic corners
  pFill(png, 0, 0, 64, 128, [20, 18, 30, 255]);
  if (type === 'tl') {
    pFill(png, 0, 80, 64, 48, [30, 25, 40, 255]);
  } else if (type === 'tr') {
    pFill(png, 0, 80, 48, 48, [30, 25, 40, 255]);
  } else if (type === 'bl') {
    pFill(png, 16, 80, 48, 48, [30, 25, 40, 255]);
  } else if (type === 'br') {
    pFill(png, 0, 80, 16, 48, [30, 25, 40, 255]);
  }
  // Grounding shadow
  pFill(png, 0, 126, 64, 2, [0, 0, 0, 80]);
}

function drawDoorClosed(png: PNG) {
  drawWallH(png);
  pFill(png, 10, 60, 44, 68, C['L'] as number[]); // Door
  pFill(png, 14, 64, 36, 60, C['l'] as number[]); // Door panels
  pFill(png, 45, 90, 4, 4, [160, 170, 180, 255]); // Knob
  // Grounding shadow
  pFill(png, 0, 126, 64, 2, [0, 0, 0, 80]);
}

function drawDoorOpen(png: PNG) {
  drawWallH(png);
  // Draw opening
  pFill(png, 10, 60, 44, 68, [0, 0, 0, 150]);
  // Open door leaf swung back
  pFill(png, 10, 80, 6, 48, C['l'] as number[]); // thin wood profile
  pFill(png, 14, 80, 2, 48, C['L'] as number[]); // highlight

  // Add floor shadow to ground the frame
  pFill(png, 0, 124, 64, 4, [0, 0, 0, 100]);
}

function drawHero(png: PNG) {
  const heroAscii = [
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXWWWWWWWWWWWWXXXX              ',
    '            XXXWWWWWWWWWWWWWWWWWWXXX            ',
    '            XXWWWWWWWWWWWWWWWWWWWWXX            ',
    '          XXXWWWWWWWWWWWWWWWWWWWWWWXXX          ',
    '          XXWWWWWWWWWWWWWWWWWWWWWWWWXX          ',
    '          XXWWWWWWWWWWWWWWWWWWWWWWWWXX          ',
    '          XXWWWWWWWWWWWWWWWWWWWWWWWWXX          ',
    '          XXXWWWWWWWWWWWWWWWWWWWWWWXXX          ',
    '            XXWWWWWWWWWWWWWWWWWWWWXX            ',
    '            XXXWWWWWWWWWWWWWWWWWWXXX            ',
    '              XXXXWWWWWWWWWWWWXXXX              ',
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXSSSSSSSSSSSSXXXX              ',
    '            XXXSSSSSSSSSSSSSSSSSSXXX            ',
    '          XXXSSSSSSSSSSSSSSSSSSSSSSXXX          ',
    '          XXSSSSSSXXSSSSSSSSXXSSSSSSXX          ',
    '          XXSSSSXXXXSSSSSSSSXXXXSSSSXX          ',
    '          XXSSSSXXWXXSSSSSSXXWXXSSSSXX          ',
    '          XXSSSSXXXXSSSSSSSSXXXXSSSSXX          ',
    '          XXSSSSSSSSSSSSSSSSSSSSSSSSXX          ',
    '          XXSSSSSSSSSSSSSSSSSSSSSSSSXX          ',
    '          XXXSSSSSSSSSSSSSSSSSSSSSSXXX          ',
    '            XXXSSSSSSSSSSSSSSSSSSXXX            ',
    '              XXXXSSSSSSSSSSSSXXXX              ',
    '                XXXXSSSSSSSSXXXX                ',
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXBBBBBBBBBBBBXXXX              ',
    '            XXXBBBBBBBBBBBBBBBBBBXXX            ',
    '          XXXBBBBBBBBBBBBBBBBBBBBBBXXX          ',
    '          XXBBBBBBBBBBBBBBBBBBBBBBBBXX          ',
    '          XXBBBBBBBBBBBBBBBBBBBBBBBBXX          ',
    '          XXBBBBBBBBBBBBBBBBBBBBBBBBXX          ',
    '          XXXBBBBBBBBBBBBBBBBBBBBBBXXX          ',
    '            XXBBBBBBBBBBBBBBBBBBWWXX            ',
    '            XXXBBBBBBBBBBBBBBBBWWXXX            ',
    '              XXXXBBBBBBBBBBBBXXXX              ',
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXPPPPPPPPPPPPXXXX              ',
    '            XXXPPPPPPPPPPPPPPPPPPXXX            ',
    '          XXXPPPPPPPPPPPPPPPPPPPPPPXXX          ',
    '          XXPPPPPPPPPPPPPPPPPPPPPPPPXX          ',
    '          XXPPPPPPPPPPPPPPPPPPPPPPPPXX          ',
    '          XXPPPPPPPPPPPPPPPPPPPPPPPPXX          ',
    '          XXXPPPPPPPPPPPPPPPPPPPPPPXXX          ',
    '            XXPPPPPPPPPPPPPPPPPPPPXX            ',
    '            XXXPPPPPPPPPPPPPPPPPPXXX            ',
    '              XXXXPPPPPPPPPPPPXXXX              ',
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXLLLLLLLLLLLLXXXX              ',
    '            XXXLLLLLLLLLLLLLLLLLLXXX            ',
    '          XXXLLLLLLLLLLLLLLLLLLLLLLXXX          ',
    '          XXLLLLLLLLLLLLLLLLLLLLLLLLXX          ',
    '          XXLLLLLLLLLLLLLLLLLLLLLLLLXX          ',
    '          XXLLLLLLLLLLLLLLLLLLLLLLLLXX          ',
    '          XXXLLLLLLLLLLLLLLLLLLLLLLXXX          ',
    '            XXLLLLLLLLLLLLLLLLLLLLXX            ',
    '            XXXLLLLLLLLLLLLLLLLLLXXX            ',
    '              XXXXLLLLLLLLLLLLXXXX              ',
    '                XXXXXXXXXXXXXXXX                ',
  ];
  drawAscii(png, heroAscii, 0, 0);
}

function drawSlime(png: PNG) {
  const slimeAscii = [
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                XXXXXXXXXXXXXXXX                ',
    '              XXXXGGGGGGGGGGGGXXXX              ',
    '            XXXGGGGGGGGGGGGGGGGGGXXX            ',
    '          XXXGGGGGGGGGGGGGGGGGGGGGGXXX          ',
    '         XXGGGGGGGGGGGGGGGGGGGGGGGGGGXX         ',
    '        XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX        ',
    '       XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX       ',
    '      XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX      ',
    '      XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX      ',
    '     XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX     ',
    '    XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX    ',
    '    XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX    ',
    '   XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX   ',
    '  XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX  ',
    '  XXGGGGGGXXGGGGGGGGGGGGGGGGGGGGGGXXGGGGGGGGXX  ',
    ' XXGGGGGGXXXXGGGGGGGGGGGGGGGGGGGGXXXXGGGGGGGGXX ',
    ' XXGGGGGGXWWXGGGGGGGGGGGGGGGGGGGGXWWXGGGGGGGGXX ',
    ' XXGGGGGGXWWXGGGGGGGGGGGGGGGGGGGGXWWXGGGGGGGGXX ',
    ' XXGGGGGGXXXXGGGGGGGGGGGGGGGGGGGGXXXXGGGGGGGGXX ',
    ' XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX ',
    ' XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX ',
    ' XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX ',
    ' XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX ',
    '  XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX  ',
    '  XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX  ',
    '   XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX   ',
    '    XXGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGXX    ',
    '    XXddddddddddddddddddddddddddddddddddddXX    ',
    '     XXddddddddddddddddddddddddddddddddddXX     ',
    '      XXddddddddddddddddddddddddddddddddXX      ',
    '      XXddddddddddddddddddddddddddddddddXX      ',
    '       XXddddddddddddddddddddddddddddddXX       ',
    '        XXddddddddddddddddddddddddddddXX        ',
    '         XXddddddddddddddddddddddddddXX         ',
    '          XXXddddddddddddddddddddddXXX          ',
    '            XXXddddddddddddddddddXXX            ',
    '              XXXXddddddddddddXXXX              ',
    '                XXXXXXXXXXXXXXXX                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
  ];
  drawAscii(png, slimeAscii, 0, 0);
}

function drawRat(png: PNG) {
  const ratAscii = [
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '        XXXXXX                    XXXXXX        ',
    '      XXXRRRRXXX                XXXRRRRXXX      ',
    '    XXXRRRRRRRRXXX            XXXRRRRRRRRXXX    ',
    '   XXRRRRRRRRRRRRXX          XXRRRRRRRRRRRRXX   ',
    '  XXRRRRRRRRRRRRRRXX        XXRRRRRRRRRRRRRRXX  ',
    ' XXRRRRRRRRRRRRRRRRXX      XXRRRRRRRRRRRRRRRRXX ',
    ' XXRRRRRRRRRRRRRRRRXX      XXRRRRRRRRRRRRRRRRXX ',
    ' XXRRRRRRRRRRRRRRRRXX      XXRRRRRRRRRRRRRRRRXX ',
    '  XXRRRRRRRRRRRRRRXXXXXXXXXXXXRRRRRRRRRRRRRRXX  ',
    '   XXRRRRRRRRRRRRXXRRRRRRRRRRXXRRRRRRRRRRRRXX   ',
    '    XXXRRRRRRRRXXXRRRRRRRRRRRRXXXRRRRRRRRXXX    ',
    '      XXXRRRRXXXXRRRRRRRRRRRRRRXXXXRRRRXXX      ',
    '        XXXXXXRRRRRRRRRRRRRRRRRRRRXXXXXX        ',
    '            XXRRRRRRRRRRRRRRRRRRRRXX            ',
    '          XXXRRRRRRRRRRRRRRRRRRRRRRXXX          ',
    '         XXRRRRRRRRRRRRRRRRRRRRRRRRRRXX         ',
    '         XXRRRRRRRRRRRRRRRRRRRRRRRRRRXX         ',
    '        XXRRRRRRRRRRRRRRRRRRRRRRRRRRRRXX        ',
    '        XXRRRRXXRRRRRRRRRRRRRRRRXXRRRRXX        ',
    '       XXRRRRXXXXRRRRRRRRRRRRRRXXXXRRRRXX       ',
    '       XXRRRRXWWXRRRRRRRRRRRRRRXWWXRRRRXX       ',
    '       XXRRRRXWWXRRRRRRRRRRRRRRXWWXRRRRXX       ',
    '       XXRRRRXXXXRRRRRRRRRRRRRRXXXXRRRRXX       ',
    '       XXRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRXX       ',
    '        XXRRRRRRRRRRRRRRRRRRRRRRRRRRRRXX        ',
    '        XXrrrrrrrrrrrrrrrrrrrrrrrrrrrrXX        ',
    '         XXrrrrrrrrrrrrrrrrrrrrrrrrrrXX         ',
    '         XXrrrrrrrrrrrrrrrrrrrrrrrrrrXX         ',
    '          XXXrrrrrrrrrrrrrrrrrrrrrrXXX          ',
    '            XXrrrrrrrrrrrrrrrrrrrrXX            ',
    '            XXrrrrrrrrrrrrrrrrrrrrXX            ',
    '             XXrrrrrrrrrrrrrrrrrrXX             ',
    '             XXXXXXXXXXXXXXXXXXXXXX             ',
    '             XX  XXXX      XXXX  XX             ',
    '             X    XX        XX    X             ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
  ];
  drawAscii(png, ratAscii, 0, 0);
}

function drawFireball(png: PNG) {
  const fireAscii = [
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                     XXXXXX                     ',
    '                   XXXeeeeXXX                   ',
    '                 XXXeeeeeeeeXXX                 ',
    '                XXeeeeeeeeeeeeXX                ',
    '              XXXeeeeeeeeeeeeeeXXX              ',
    '             XXeeeeeeeeeeeeeeeeeeXX             ',
    '            XXeeeeeeeeeeeeeeeeeeeeXX            ',
    '           XXeeeeeeeffffffffeeeeeeeXX           ',
    '          XXeeeeeeffffffffffffeeeeeeXX          ',
    '         XXeeeeeffffffffffffffffeeeeeXX         ',
    '         XXeeeeffffffffffffffffffeeeeXX         ',
    '        XXeeeeffffffFFFFFFFFffffffeeeeXX        ',
    '       XXeeeeffffffFFFFFFFFFFffffffeeeeXX       ',
    '       XXeeeefffffFFFFFFFFFFFFfffffeeeeXX       ',
    '      XXeeeefffffFFFFFFFFFFFFFFfffffeeeeXX      ',
    '      XXeeeefffffFFFFFFFFFFFFFFfffffeeeeXX      ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '     XXeeeeffffffFFFFFFFFFFFFFFffffffeeeeXX     ',
    '      XXeeeefffffFFFFFFFFFFFFFFfffffeeeeXX      ',
    '      XXeeeefffffFFFFFFFFFFFFFFfffffeeeeXX      ',
    '       XXeeeefffffFFFFFFFFFFFFfffffeeeeXX       ',
    '       XXeeeeffffffFFFFFFFFFFffffffeeeeXX       ',
    '        XXeeeeffffffFFFFFFFFffffffeeeeXX        ',
    '         XXeeeeffffffffffffffffffeeeeXX         ',
    '         XXeeeeeffffffffffffffffeeeeeXX         ',
    '          XXeeeeeeffffffffffffeeeeeeXX          ',
    '           XXeeeeeeeffffffffeeeeeeeXX           ',
    '            XXeeeeeeeeeeeeeeeeeeeeXX            ',
    '             XXeeeeeeeeeeeeeeeeeeXX             ',
    '              XXXeeeeeeeeeeeeeeXXX              ',
    '                XXeeeeeeeeeeeeXX                ',
    '                 XXXeeeeeeeeXXX                 ',
    '                   XXXeeeeXXX                   ',
    '                     XXXXXX                     ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
    '                                                ',
  ];
  drawAscii(png, fireAscii, 0, 0);
}

function savePng(png: PNG, filename: string) {
  const outDir = path.join(__dirname, '..', 'public', 'assets', 'generated');
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  const buf = PNG.sync.write(png);
  fs.writeFileSync(path.join(outDir, filename), buf);
}

// Generate all assets
console.log('Generating native 64x64 sprites...');

for (let i = 0; i < 16; i++) {
  const png = createEmptyPNG();
  drawFloorOnPng(png, i);
  savePng(png, `temp_floor_${i}.png`);
}

for (let i = 0; i < 4; i++) {
  const pngH = createEmptyPNG(64, 128);
  drawWallH(pngH, i);
  savePng(pngH, `temp_wall_h_${i}.png`);

  const pngV = createEmptyPNG(64, 128);
  drawWallV(pngV, i);
  savePng(pngV, `temp_wall_v_${i}.png`);
}

const tl = createEmptyPNG(64, 128);
drawWallCorner(tl, 'tl');
savePng(tl, `temp_wall_tl.png`);
const tr = createEmptyPNG(64, 128);
drawWallCorner(tr, 'tr');
savePng(tr, `temp_wall_tr.png`);
const bl = createEmptyPNG(64, 128);
drawWallCorner(bl, 'bl');
savePng(bl, `temp_wall_bl.png`);
const br = createEmptyPNG(64, 128);
drawWallCorner(br, 'br');
savePng(br, `temp_wall_br.png`);

const dc = createEmptyPNG(64, 128);
drawDoorClosed(dc);
savePng(dc, `temp_door_closed.png`);
const do_op = createEmptyPNG(64, 128);
drawDoorOpen(do_op);
savePng(do_op, `temp_door_open.png`);

const hero = createEmptyPNG();
drawHero(hero);
savePng(hero, `temp_hero.png`);
const slime = createEmptyPNG();
drawSlime(slime);
savePng(slime, `temp_slime.png`);
const rat = createEmptyPNG();
drawRat(rat);
savePng(rat, `temp_rat.png`);
const fireball = createEmptyPNG();
drawFireball(fireball);
savePng(fireball, `temp_fireball.png`);

console.log('Done.');
