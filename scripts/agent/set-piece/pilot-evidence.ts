import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import evidenceJson from '../../../src/shared/data/set-piece-evidence/welcome-room-v2.json';
import {
  getSetPieceDef,
  installDefaultSetPiecePacks,
  type SetPieceDef,
} from '../../../src/shared/set-piece-types.js';

const pointSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['door', 'npc']),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
});

const zoneSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  x: z.number().int().nonnegative(),
  y: z.number().int().nonnegative(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  activity: z.string().min(1),
});

const evidenceSchema = z.object({
  version: z.literal(1),
  setPieceId: z.literal('welcome-room-v2'),
  narrativeVerb: z.string().startsWith('The player '),
  primaryPurpose: z.string().min(1),
  projection: z.object({
    camera: z.literal('top-down-3/4'),
    tilePx: z.literal(16),
    feetPerTile: z.literal(4),
    depthAnchor: z.literal('bottom-center'),
    shadowVector: z.string().min(1),
    nativeScale: z.literal(1),
  }),
  composition: z.object({
    archetype: z.literal('welcome-room'),
    mode: z.literal('clustered'),
    focalPropId: z.string().min(1),
    breathingZone: z.string().min(1),
  }),
  preRenderTarget: z.object({
    stage: z.literal('pre-decomposition'),
    visualAsset: z.string().endsWith('.svg'),
    canvas: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
      scale: z.enum(['native-1x', 'blockout-4x']),
      scaleFactor: z.number().int().positive(),
    }),
    focal: z.object({
      zoneId: z.string().min(1),
      boundsFeet: z.object({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
    }),
    circulation: z.object({
      minimumWidthTiles: z.literal(2),
      route: z.array(z.string().min(1)).min(2),
    }),
    negativeSpace: z.object({
      zoneId: z.string().min(1),
      purpose: z.string().min(1),
    }),
    layers: z
      .array(
        z.enum([
          'shell',
          'zone-masses',
          'npc-silhouettes',
          'focal-mass',
          'circulation',
          'relationship-markers',
        ]),
      )
      .min(5),
    decomposition: z.literal('pending'),
  }),
  zones: z.array(zoneSchema).min(3),
  vignettes: z
    .array(
      z.object({
        id: z.string().min(1),
        zoneId: z.string().min(1),
        propIds: z.array(z.string().min(1)).min(1),
        story: z.string().min(1),
      }),
    )
    .min(2),
  anchors: z.array(pointSchema).min(2),
  grounding: z.object({
    corePack: z
      .array(z.object({ assetId: z.string().min(1), usedFor: z.array(z.string()).min(1) }))
      .min(3),
    stagePack: z
      .array(z.object({ assetId: z.string().min(1), usedFor: z.array(z.string()).min(1) }))
      .min(1),
    rejectedReferences: z.array(
      z.object({ assetId: z.string().min(1), reason: z.string().min(1) }),
    ),
    intentionalDeviations: z.array(
      z.object({ property: z.string().min(1), reason: z.string().min(1) }),
    ),
  }),
  lore: z.object({
    canonSources: z.array(z.object({ path: z.string().min(1), claim: z.string().min(1) })).min(3),
  }),
  evidence: z.object({
    runtimeArtifact: z.literal('initializeFloor1Scenario'),
    seedMatrix: z.array(z.number().int()).min(1),
    visualViews: z.array(z.enum(['native-1x', 'nearest-neighbor-4x', 'geometry-overlay'])).min(2),
    subjectiveReview: z.literal('advisory'),
  }),
});

export type SetPieceEvidence = z.infer<typeof evidenceSchema>;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const SCALE_FACTORS: Record<SetPieceEvidence['preRenderTarget']['canvas']['scale'], number> = {
  'native-1x': 1,
  'blockout-4x': 4,
};

function assertWithinRoom(point: { x: number; y: number }, def: SetPieceDef, label: string): void {
  if (point.x >= def.width || point.y >= def.height) {
    throw new Error(`${label} (${point.x},${point.y}) is outside ${def.width}x${def.height}.`);
  }
}

/** Reads the declared pixel canvas of the committed pre-render target. */
function readSvgCanvas(assetPath: string): { width: number; height: number } {
  const absolute = path.resolve(repoRoot, assetPath);
  let svg: string;
  try {
    svg = readFileSync(absolute, 'utf8');
  } catch {
    throw new Error(`Pre-render visual asset "${assetPath}" does not exist.`);
  }
  const openingTag = /<svg\b[^>]*>/.exec(svg)?.[0] ?? '';
  const width = Number(/\bwidth="(\d+)"/.exec(openingTag)?.[1]);
  const height = Number(/\bheight="(\d+)"/.exec(openingTag)?.[1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Pre-render visual asset "${assetPath}" declares no positive width/height.`);
  }
  return { width, height };
}

export function validateWelcomeRoomV2Evidence(raw: unknown = evidenceJson): SetPieceEvidence {
  const evidence = evidenceSchema.parse(raw);
  installDefaultSetPiecePacks();
  const def = getSetPieceDef(evidence.setPieceId);
  if (def === undefined) throw new Error(`Missing set piece "${evidence.setPieceId}".`);

  const zoneIds = new Set(evidence.zones.map((zone) => zone.id));
  for (const zone of evidence.zones) {
    if (zone.x + zone.width > def.width || zone.y + zone.height > def.height) {
      throw new Error(`Zone "${zone.id}" extends outside the set-piece footprint.`);
    }
  }
  if (!zoneIds.has(evidence.composition.breathingZone)) {
    throw new Error(`Breathing zone "${evidence.composition.breathingZone}" is not declared.`);
  }
  if (!zoneIds.has(evidence.preRenderTarget.focal.zoneId)) {
    throw new Error(
      `Pre-render focal zone "${evidence.preRenderTarget.focal.zoneId}" is not declared.`,
    );
  }
  if (!zoneIds.has(evidence.preRenderTarget.negativeSpace.zoneId)) {
    throw new Error(
      `Pre-render negative-space zone "${evidence.preRenderTarget.negativeSpace.zoneId}" is not declared.`,
    );
  }
  const focalBounds = evidence.preRenderTarget.focal.boundsFeet;
  const roomWidthFeet = def.width * evidence.projection.feetPerTile;
  const roomHeightFeet = def.height * evidence.projection.feetPerTile;
  if (
    focalBounds.x + focalBounds.width > roomWidthFeet ||
    focalBounds.y + focalBounds.height > roomHeightFeet
  ) {
    throw new Error('Pre-render focal bounds extend outside the set-piece footprint.');
  }
  const focalZone = evidence.zones.find(
    (zone) => zone.id === evidence.preRenderTarget.focal.zoneId,
  );
  if (focalZone === undefined) {
    throw new Error(`Pre-render focal zone "${evidence.preRenderTarget.focal.zoneId}" is missing.`);
  }
  const feet = evidence.projection.feetPerTile;
  if (
    focalBounds.x < focalZone.x * feet ||
    focalBounds.y < focalZone.y * feet ||
    focalBounds.x + focalBounds.width > (focalZone.x + focalZone.width) * feet ||
    focalBounds.y + focalBounds.height > (focalZone.y + focalZone.height) * feet
  ) {
    throw new Error(`Pre-render focal bounds extend outside zone "${focalZone.id}".`);
  }
  const { canvas, visualAsset } = evidence.preRenderTarget;
  if (canvas.scaleFactor !== SCALE_FACTORS[canvas.scale]) {
    throw new Error(`Pre-render canvas scale "${canvas.scale}" contradicts its scale factor.`);
  }
  const expectedWidth = def.width * evidence.projection.tilePx * canvas.scaleFactor;
  const expectedHeight = def.height * evidence.projection.tilePx * canvas.scaleFactor;
  if (canvas.width !== expectedWidth || canvas.height !== expectedHeight) {
    throw new Error(
      `Pre-render canvas ${canvas.width}x${canvas.height} does not match the ${canvas.scale} projection ${expectedWidth}x${expectedHeight}.`,
    );
  }
  const svgCanvas = readSvgCanvas(visualAsset);
  if (svgCanvas.width !== canvas.width || svgCanvas.height !== canvas.height) {
    throw new Error(
      `Pre-render visual asset "${visualAsset}" is ${svgCanvas.width}x${svgCanvas.height}, not the declared ${canvas.width}x${canvas.height}.`,
    );
  }

  const anchorIds = new Set(evidence.anchors.map((anchor) => anchor.id));
  const route = evidence.preRenderTarget.circulation.route;
  if (route[0] !== 'door-entry') {
    throw new Error('Pre-render circulation must start at the room door.');
  }
  for (const node of route) {
    if (!zoneIds.has(node) && !anchorIds.has(node)) {
      throw new Error(`Pre-render circulation node "${node}" is not a declared zone or anchor.`);
    }
  }

  const propIds = new Set(def.props.map((prop) => prop.id));
  const npcIds = new Set(def.npcs.map((npc) => npc.id));
  for (const vignette of evidence.vignettes) {
    if (!zoneIds.has(vignette.zoneId))
      throw new Error(`Vignette "${vignette.id}" references an unknown zone.`);
    for (const propId of vignette.propIds) {
      if (!propIds.has(propId))
        throw new Error(`Vignette "${vignette.id}" references missing prop "${propId}".`);
    }
  }
  if (!propIds.has(evidence.composition.focalPropId)) {
    throw new Error(`Focal prop "${evidence.composition.focalPropId}" is missing.`);
  }
  for (const anchor of evidence.anchors) {
    assertWithinRoom(anchor, def, `Anchor "${anchor.id}"`);
    const exists = anchor.kind === 'door' ? propIds.has(anchor.id) : npcIds.has(anchor.id);
    if (!exists) throw new Error(`Anchor "${anchor.id}" is not present in the set piece.`);
  }

  return evidence;
}
