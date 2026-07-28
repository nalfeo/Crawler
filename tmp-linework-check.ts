import {
  rasterizeLineworkFrame,
  isEndCapMask,
  TRACK_PROFILE,
  PIPE_PROFILE,
  LINEWORK_CELL_PX,
  stubSpan,
} from './scripts/sprites/terrain-packs/gen/linework-geometry.ts';
const S = LINEWORK_CELL_PX;
function edgeProfile(g, edge) {
  const out = [];
  for (let i = 0; i < S; i++) {
    if (edge === 'N') out.push(g[i] ? 1 : 0);
    else if (edge === 'S') out.push(g[(S - 1) * S + i] ? 1 : 0);
    else if (edge === 'W') out.push(g[i * S] ? 1 : 0);
    else out.push(g[i * S + (S - 1)] ? 1 : 0);
  }
  return out.join('');
}
const BITS = { N: 1, E: 2, S: 4, W: 8 };
for (const [name, prof] of [
  ['track', TRACK_PROFILE],
  ['pipe', PIPE_PROFILE],
]) {
  const seen = {};
  let bad = 0;
  for (let m = 0; m < 16; m++) {
    const g = rasterizeLineworkFrame(m, prof, isEndCapMask(m));
    for (const e of ['N', 'E', 'S', 'W']) {
      const p = edgeProfile(g, e);
      if (m & BITS[e]) {
        if (seen[e] === undefined) seen[e] = p;
        else if (seen[e] !== p) {
          console.log(name, 'MISMATCH', e, 'mask', m, p, seen[e]);
          bad++;
        }
      } else if (p.includes('1')) {
        console.log(name, 'LEAK', e, 'mask', m, p);
        bad++;
      }
    }
  }
  const counts = [];
  for (let m = 0; m < 16; m++)
    counts.push(
      rasterizeLineworkFrame(m, prof, isEndCapMask(m)).reduce((a, b) => a + (b ? 1 : 0), 0),
    );
  console.log(name, 'bad=', bad, 'span=', JSON.stringify(stubSpan(prof)), 'px=', counts.join(','));
  console.log(name, 'N profile:', seen.N, '\n' + name, 'E profile:', seen.E);
}
