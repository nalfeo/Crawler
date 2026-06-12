import fs from 'fs';
import { PNG } from 'pngjs';

const data = fs.readFileSync('public/assets/kenney/roguelike-characters/spritesheet.png');
const png = PNG.sync.read(data);

const frameW = 16;
const frameH = 16;
const spacing = 1;
const cols = 54;
const rows = 12;

for (let r = 0; r < 3; r++) {
  // just check first 3 rows
  for (let c = 0; c < 10; c++) {
    const xBase = c * (frameW + spacing);
    const yBase = r * (frameH + spacing);
    let str = `Frame ${r * cols + c} (r:${r}, c:${c}):\n`;
    for (let y = 0; y < frameH; y += 2) {
      let line = '';
      for (let x = 0; x < frameW; x++) {
        const idx = ((yBase + y) * png.width + (xBase + x)) * 4;
        const alpha = png.data[idx + 3];
        if (alpha > 128) {
          line += '#';
        } else {
          line += '.';
        }
      }
      str += line + '\n';
    }
    console.log(str);
  }
}
