// Authors the 14 welcome-room briefs from the verbatim set-piece prompts.
// Brief name === bare requestId so art auto-resolves on check-in.
import fs from 'node:fs';
import path from 'node:path';
import { log } from 'node:console';

const CONTRACT =
  'Warm desaturated dungeon palette with faded showbiz red and tarnished gold accents. ' +
  'Lit from the top wall; soft one-pixel contact shadow down and to the right. ' +
  'Worn by decades of syndication — dusty, threadbare, slightly grimy. ' +
  '3/4 top-down pixel art, silhouette readable at 16px.';

const COHESION =
  'This prop must sit beside the already-approved welcome-room art without clashing: ' +
  'welcome-room-desk, welcome-room-bookcase, welcome-room-shop-table, welcome-room-rug, ' +
  'welcome-room-velvet-rope, welcome-sign-left and prop-wall-sconce — deep maroon and ' +
  'dark walnut wood, tarnished brass hardware, hard dark outline, muted and dusty, never bright ' +
  'or saturated.';

// requestId -> { type, sizeVariant, ft, extra }
const SPEC = {
  'welcome-room-potted-plant': { type: 'prop', sizeVariant: 'default', ft: '2.5 x 2.5 feet' },
  'welcome-room-side-table': { type: 'prop', sizeVariant: 'default', ft: '2.5 x 2.5 feet' },
  'welcome-room-lounge-stool': { type: 'prop', sizeVariant: 'default', ft: '2.5 x 2.5 feet' },
  'welcome-room-show-poster': { type: 'prop', sizeVariant: 'large', ft: '3 x 4 feet' },
  'welcome-room-camera-rig': { type: 'prop', sizeVariant: 'default', ft: '2.5 x 2.5 feet' },
  'welcome-room-crate-stack': { type: 'prop', sizeVariant: 'large', ft: '3 x 3.5 feet' },
  'welcome-room-wall-shelf': { type: 'prop', sizeVariant: 'wide', ft: '3 x 1.5 feet' },
  'welcome-room-cable-coil': { type: 'prop', sizeVariant: 'wide', ft: '2.5 x 1.5 feet' },
  'welcome-room-crate-single': { type: 'prop', sizeVariant: 'default', ft: '2.5 x 2.5 feet' },
  'welcome-room-trash-bin': { type: 'prop', sizeVariant: 'default', ft: '2 x 2.5 feet' },
  'welcome-room-floor-worn': { type: 'tile', sizeVariant: 'default', ft: '2 x 2 feet' },
  'welcome-room-floor-stain': { type: 'tile', sizeVariant: 'default', ft: '2 x 2 feet' },
  'welcome-room-floor-tape': { type: 'tile', sizeVariant: 'default', ft: '2 x 2 feet' },
  'welcome-room-floor-seam': { type: 'tile', sizeVariant: 'default', ft: '2 x 2 feet' },
};

const CARPET =
  'CRITICAL: this is a WARM ORANGE CARPET tile, not stone, not cave rock, not sewer tile. ' +
  "Woven carpet nap texture in the room's warm orange-to-maroon range, matching and sitting " +
  'seamlessly beside welcome-room-rug. It must tile edge-to-edge seamlessly at 16px with no ' +
  'border, no frame, no vignette and no transparent margin — the pattern must run right off ' +
  'all four edges so a grid of these reads as one continuous carpet.';

const raw = JSON.parse(fs.readFileSync('src/shared/data/set-pieces.json', 'utf8'));
const arr = Array.isArray(raw) ? raw : raw.setPieces || Object.values(raw);
const piece = arr.find((p) => p && p.id === 'welcome-room');

const seen = new Map();
for (const prop of piece.props || []) {
  for (const layer of prop.layers || []) {
    const s = layer.sprite;
    if (!s || s.source !== 'custom') continue;
    if (!seen.has(s.requestId))
      seen.set(s.requestId, { sprite: s, w: layer.widthFt, h: layer.heightFt });
  }
}

const yamlBlock = (text) =>
  text
    .split('\n')
    .map((l) => '  ' + l)
    .join('\n');

let written = 0;
for (const [requestId, { sprite }] of seen) {
  const spec = SPEC[requestId];
  if (!spec) throw new Error(`no spec for ${requestId}`);

  let body = sprite.prompt.trim();
  // Inject the room art contract verbatim if the prompt doesn't already carry it.
  if (!body.includes('Worn by decades of syndication')) {
    body += ' ' + CONTRACT;
  }
  body += `\n\nRendered in the game at approximately ${spec.ft} (1 tile = 16px = 2 feet). The art must read believably at that size — keep detail count low enough to survive at 16px and do not over-detail.`;
  body += `\n\n${COHESION}`;
  if (spec.type === 'tile') body += `\n\n${CARPET}`;

  const dir = spec.type === 'tile' ? 'briefs/tiles' : 'briefs/props';
  fs.mkdirSync(dir, { recursive: true });

  const lines = [
    `type: ${spec.type}`,
    `name: ${requestId}`,
    ...(spec.sizeVariant !== 'default' ? [`sizeVariant: ${spec.sizeVariant}`] : []),
    `description: |`,
    yamlBlock(body),
    `tags:`,
    ...(sprite.tags || []).map((t) => `  - ${t}`),
    `judge:`,
    `  enabled: true`,
    `  maxVariants: 8`,
    `minVariations: 0`,
    ``,
  ];
  const out = path.join(dir, `${requestId}.yaml`);
  fs.writeFileSync(out, lines.join('\n'));
  log('wrote', out, `(${spec.type}/${spec.sizeVariant})`);
  written++;
}
log('total briefs:', written);
