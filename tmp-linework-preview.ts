import fs from 'node:fs';
import { decodePng, encodePng } from './scripts/sprites/terrain-packs/png-buffer.ts';
const dir = 'public/assets/terrain-packs/industrial-cave/';
const track = decodePng(fs.readFileSync(dir + 'linework-track.png'));
const pipe = decodePng(fs.readFileSync(dir + 'linework-pipe.png'));
const props = decodePng(fs.readFileSync(dir + 'linework-props.png'));
// Lay out a 6x3 tile scene: a pipe run with an elbow, a track run with a T.
const S = 64,
  ZOOM = 5,
  COLS = 8,
  ROWS = 4;
const W = COLS * S * ZOOM,
  H = ROWS * S * ZOOM;
const out = { width: W, height: H, data: Buffer.alloc(W * H * 4) };
for (let i = 0; i < W * H; i++) {
  out.data[i * 4] = 26;
  out.data[i * 4 + 1] = 24;
  out.data[i * 4 + 2] = 22;
  out.data[i * 4 + 3] = 255;
}
function stamp(atlas, frame, cx, cy) {
  for (let y = 0; y < S * ZOOM; y++)
    for (let x = 0; x < S * ZOOM; x++) {
      const sx = frame * S + Math.floor(x / ZOOM),
        sy = Math.floor(y / ZOOM);
      const si = (sy * atlas.width + sx) * 4;
      if (atlas.data[si + 3] === 0) continue;
      const di = ((cy * S * ZOOM + y) * W + cx * S * ZOOM + x) * 4;
      out.data[di] = atlas.data[si];
      out.data[di + 1] = atlas.data[si + 1];
      out.data[di + 2] = atlas.data[si + 2];
      out.data[di + 3] = 255;
    }
}
const N = 1,
  E = 2,
  Sb = 4,
  Wb = 8;
// row0: pipe horizontal run with a T and elbow
stamp(pipe, E, 0, 0);
stamp(pipe, E | Wb, 1, 0);
stamp(pipe, E | Wb | Sb, 2, 0);
stamp(pipe, E | Wb, 3, 0);
stamp(pipe, Wb | Sb, 4, 0);
stamp(pipe, N | Sb, 2, 1);
stamp(pipe, N, 2, 2);
stamp(pipe, N | Sb, 4, 1);
stamp(pipe, N | E, 4, 2);
stamp(pipe, Wb | E, 5, 2);
stamp(pipe, Wb, 6, 2);
// row3: track run
for (let i = 0; i < 8; i++) stamp(track, i === 0 ? E : i === 7 ? Wb : E | Wb, i, 3);
stamp(track, E | Wb | N, 3, 3);
stamp(track, Sb, 3, 2);
stamp(props, 0, 6, 0);
stamp(props, 2, 7, 0);
stamp(props, 3, 7, 1);
fs.mkdirSync('files', { recursive: true });
fs.writeFileSync('files/linework-preview.png', encodePng(out));
console.log('wrote files/linework-preview.png', W, H);
