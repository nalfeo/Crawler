import fs from 'fs';
import { PNG } from 'pngjs';

const data = fs.readFileSync('public/assets/kenney/roguelike-characters/spritesheet.png');
const png = PNG.sync.read(data);

const frameW = 16;
const frameH = 16;
const spacing = 1;

for (const f of [
  { name: 'enemy.rat', col: 26, row: 7 },
  { name: 'enemy.slime', col: 27, row: 7 },
  { name: 'enemy.boss', col: 28, row: 7 },
]) {
  const xBase = f.col * (frameW + spacing);
  const yBase = f.row * (frameH + spacing);

  let str = `${f.name} (col: ${f.col}, row: ${f.row}):\n`;
  for (let y = 0; y < frameH; y += 2) {
    let line = '';
    for (let x = 0; x < frameW; x++) {
      const idx1 = ((yBase + y) * png.width + (xBase + x)) * 4;
      const alpha1 = png.data[idx1 + 3];

      const idx2 = ((yBase + y + 1) * png.width + (xBase + x)) * 4;
      const alpha2 = y + 1 < frameH ? png.data[idx2 + 3] : 0;

      if (alpha1 > 128 && alpha2 > 128) {
        line += '█';
      } else if (alpha1 > 128) {
        line += '▀';
      } else if (alpha2 > 128) {
        line += '▄';
      } else {
        line += ' ';
      }
    }
    str += line + '\n';
  }
  console.log(str);
}
