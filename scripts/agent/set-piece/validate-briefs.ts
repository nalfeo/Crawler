import { loadBrief } from '../../sprites/load-brief.js';
for (const p of process.argv.slice(2)) {
  const b = loadBrief(p);
  console.log(
    p,
    '=> name:',
    b.brief.name,
    '| size:',
    JSON.stringify(b.brief.size),
    '| grid:',
    JSON.stringify(b.brief.generation.sheet.rows + 'x' + b.brief.generation.sheet.cols),
    '| anchor:',
    JSON.stringify(b.brief.sensors.anchor),
  );
}
