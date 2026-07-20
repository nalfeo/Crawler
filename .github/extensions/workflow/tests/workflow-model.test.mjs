/**
 * Unit tests for the ported backlog/report domain logic (`lib/workflow-model.mjs`).
 * These are the numbers/labels the canvas must show identically to the monolith,
 * so we test both the pure helpers and the fs-backed `loadBacklog` against a
 * throwaway temp fixture tree (no dependency on the repo's real plans/briefs).
 * Explicitly covers the canvas-only "integration unverified" degrade path.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveIntegrationState,
  resolveArtPlanStatus,
  briefKey,
  parseFloorArtPlans,
  parseCommittedBriefKeys,
  parseDraftBriefKeys,
  parseApprovedSprites,
  buildFloorArtPlanReport,
  normalizeAssetPath,
  loadBacklog,
  STATUS_ORDER,
  ALL_STATUSES,
} from '../lib/workflow-model.mjs';

// ---- pure helpers ---------------------------------------------------------

test('resolveIntegrationState honours registry/catalog membership', () => {
  const sprites = new Set(['enemy_goblin']);
  const items = new Set(['potion']);
  assert.equal(resolveIntegrationState(null, false, sprites, items), 'not-applicable');
  assert.equal(
    resolveIntegrationState({ kind: 'sprite-registry', id: 'enemy_goblin' }, false, sprites, items),
    'integrated',
  );
  assert.equal(
    resolveIntegrationState({ kind: 'sprite-registry', id: 'missing' }, false, sprites, items),
    'missing',
  );
  // item-catalog also requires the approved asset file to exist on disk.
  assert.equal(
    resolveIntegrationState({ kind: 'item-catalog', id: 'potion' }, true, sprites, items),
    'integrated',
  );
  assert.equal(
    resolveIntegrationState({ kind: 'item-catalog', id: 'potion' }, false, sprites, items),
    'missing',
  );
});

test('resolveArtPlanStatus maps the full monolith status ladder', () => {
  const base = {
    briefAuthored: false,
    draftAuthored: false,
    approved: false,
    approvedAssetExists: false,
    integrationState: 'not-applicable',
    placeholderInUse: false,
  };
  assert.equal(
    resolveArtPlanStatus({ ...base, approved: true, approvedAssetExists: false }),
    'approved-missing-file',
  );
  assert.equal(
    resolveArtPlanStatus({
      ...base,
      approved: true,
      approvedAssetExists: true,
      integrationState: 'integrated',
    }),
    'ready',
  );
  assert.equal(
    resolveArtPlanStatus({ ...base, approved: true, approvedAssetExists: true }),
    'approved',
  );
  assert.equal(
    resolveArtPlanStatus({
      ...base,
      approved: true,
      approvedAssetExists: true,
      integrationState: 'missing',
    }),
    'approved-not-integrated',
  );
  assert.equal(
    resolveArtPlanStatus({ ...base, briefAuthored: true, placeholderInUse: true }),
    'brief-ready-placeholder',
  );
  assert.equal(resolveArtPlanStatus({ ...base, briefAuthored: true }), 'brief-ready');
  assert.equal(
    resolveArtPlanStatus({ ...base, draftAuthored: true, placeholderInUse: true }),
    'draft-ready-placeholder',
  );
  assert.equal(resolveArtPlanStatus({ ...base, draftAuthored: true }), 'draft-ready');
  assert.equal(resolveArtPlanStatus({ ...base, placeholderInUse: true }), 'needs-art-placeholder');
  assert.equal(resolveArtPlanStatus(base), 'planned');
});

test('ALL_STATUSES is STATUS_ORDER plus the canvas-only approved-unverified (sorted last)', () => {
  assert.deepEqual(ALL_STATUSES, [...STATUS_ORDER, 'approved-unverified']);
  assert.equal(ALL_STATUSES[ALL_STATUSES.length - 1], 'approved-unverified');
});

test('normalizeAssetPath strips leading slashes and assets/ and normalises separators', () => {
  assert.equal(normalizeAssetPath('generated/x.png'), 'generated/x.png');
  assert.equal(normalizeAssetPath('/generated/x.png'), 'generated/x.png');
  assert.equal(normalizeAssetPath('assets/generated/x.png'), 'generated/x.png');
  assert.equal(normalizeAssetPath('/assets/generated/x.png'), 'generated/x.png');
  assert.equal(normalizeAssetPath('assets\\generated\\x.png'), 'generated/x.png');
});

test('briefKey composes type::name', () => {
  assert.equal(briefKey('enemy', 'goblin'), 'enemy::goblin');
});

// ---- parse helpers --------------------------------------------------------

const PLAN_YAML = [
  'id: floor1',
  'title: Floor 1',
  'summary: first floor',
  'assets:',
  '  - id: goblin',
  '    type: enemy',
  '    label: Goblin',
  '    brief: enemy/goblin',
  '    placeholderInUse: true',
  '    integration:',
  '      kind: sprite-registry',
  '      id: enemy_goblin',
  '  - id: sword',
  '    type: weapon',
  '    label: Sword',
  '    brief: weapon/sword',
  '    placeholderInUse: true',
  '',
].join('\n');

test('parseFloorArtPlans parses + sorts, rejecting malformed plans', () => {
  const plans = parseFloorArtPlans({
    'plans/a.art.yaml': PLAN_YAML,
    'plans/bad.art.yaml': 'nope: true',
  });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].id, 'floor1');
  assert.equal(plans[0].assets.length, 2);
});

test('parseFloorArtPlans accepts equipment and prop asset types', () => {
  const planYaml = [
    'id: floor1-new-types',
    'title: Floor 1 New Types',
    'assets:',
    '  - id: iron-chestplate',
    '    type: equipment',
    '    label: Iron Chestplate',
    '    brief: equipment/iron-chestplate',
    '    placeholderInUse: true',
    '  - id: barrel',
    '    type: prop',
    '    label: Barrel',
    '    brief: prop/barrel',
    '    placeholderInUse: true',
    '',
  ].join('\n');
  const plans = parseFloorArtPlans({ 'plans/a.art.yaml': planYaml });
  assert.equal(plans.length, 1);
  assert.equal(plans[0].assets.length, 2);
  assert.equal(plans[0].assets[0].type, 'equipment');
  assert.equal(plans[0].assets[1].type, 'prop');
});

test('parseCommittedBriefKeys / parseDraftBriefKeys split on the /draft/ path segment', () => {
  const raw = {
    'briefs/enemy-goblin.yaml': 'type: enemy\nname: goblin\n',
    'briefs/draft/weapon-sword.yaml': 'type: weapon\nname: sword\n',
  };
  const committed = parseCommittedBriefKeys(raw);
  const drafts = parseDraftBriefKeys(raw);
  assert.ok(committed.has('enemy::goblin'));
  assert.ok(!committed.has('weapon::sword'));
  assert.ok(drafts.has('weapon::sword'));
  assert.ok(!drafts.has('enemy::goblin'));
});

test('parseApprovedSprites skips placeholder entries and records existence', () => {
  const manifest = {
    version: 1,
    entries: {
      'enemy::goblin': {
        briefId: 'goblin',
        assetPath: 'generated/goblin.png',
        sourceRun: 'runs/x/2026',
        variantIndex: 0,
      },
      'weapon::sword': {
        briefId: 'sword',
        assetPath: 'generated/sword.png',
        sourceRun: 'placeholder',
        variantIndex: 0,
      },
    },
  };
  const approved = parseApprovedSprites(manifest, {
    existingAssets: new Set(['generated/goblin.png']),
  });
  assert.ok(approved.has('goblin'));
  assert.equal(approved.get('goblin').exists, true);
  assert.ok(!approved.has('sword'), 'placeholder entry excluded');
});

// ---- report: resolved vs unverified degrade -------------------------------

function buildOpts(overrides = {}) {
  return {
    briefKeys: new Set(['enemy::goblin']),
    draftBriefKeys: new Set(),
    approvedSprites: new Map([
      [
        'goblin',
        {
          briefId: 'goblin',
          assetPath: 'generated/goblin.png',
          sourceRun: 'runs/x',
          variantIndex: 0,
          exists: true,
        },
      ],
    ]),
    spriteRegistryIds: new Set(['enemy_goblin']),
    itemCatalogIds: new Set(),
    ...overrides,
  };
}

test('buildFloorArtPlanReport (resolved) marks an integrated approved asset ready', () => {
  const [plan] = parseFloorArtPlans({ 'p.art.yaml': PLAN_YAML });
  const report = buildFloorArtPlanReport(plan, buildOpts());
  assert.equal(report.planId, 'floor1');
  const goblin = report.assets.find((a) => a.id === 'goblin');
  assert.equal(goblin.integrationState, 'integrated');
  assert.equal(goblin.status, 'ready');
  assert.equal(report.counts.ready, 1);
});

test('buildFloorArtPlanReport (integrationResolved:false) degrades honestly to unverified', () => {
  const [plan] = parseFloorArtPlans({ 'p.art.yaml': PLAN_YAML });
  // Registry ids unavailable → integration-targeting + approved+present asset
  // becomes approved-unverified, never a fabricated missing/ready.
  const report = buildFloorArtPlanReport(plan, buildOpts({ integrationResolved: false }));
  const goblin = report.assets.find((a) => a.id === 'goblin');
  assert.equal(goblin.integrationState, 'unverified');
  assert.equal(goblin.status, 'approved-unverified');
  assert.equal(report.counts['approved-unverified'], 1);
  assert.equal(report.counts.ready, 0);
});

test('buildFloorArtPlanReport (integrationResolved:false) still labels a missing-file approval faithfully', () => {
  const [plan] = parseFloorArtPlans({ 'p.art.yaml': PLAN_YAML });
  const report = buildFloorArtPlanReport(
    plan,
    buildOpts({
      integrationResolved: false,
      approvedSprites: new Map([
        [
          'goblin',
          {
            briefId: 'goblin',
            assetPath: 'generated/goblin.png',
            sourceRun: 'runs/x',
            variantIndex: 0,
            exists: false,
          },
        ],
      ]),
    }),
  );
  const goblin = report.assets.find((a) => a.id === 'goblin');
  assert.equal(goblin.status, 'approved-missing-file');
});

// ---- loadBacklog: end-to-end over an fs fixture ---------------------------

let root;
before(() => {
  root = mkdtempSync(path.join(tmpdir(), 'workflow-backlog-'));
  mkdirSync(path.join(root, 'plans'), { recursive: true });
  mkdirSync(path.join(root, 'briefs'), { recursive: true });
  mkdirSync(path.join(root, 'public', 'assets', 'generated'), { recursive: true });
  writeFileSync(path.join(root, 'plans', 'floor1.art.yaml'), PLAN_YAML);
  writeFileSync(path.join(root, 'briefs', 'enemy-goblin.yaml'), 'type: enemy\nname: goblin\n');
  // Approved goblin asset present on disk; a placeholder entry that must NOT be
  // treated as promoted; a promoted (non-placeholder) run id to collect.
  writeFileSync(path.join(root, 'public', 'assets', 'generated', 'goblin.png'), 'png');
  writeFileSync(
    path.join(root, 'public', 'assets', 'generated', 'manifest.json'),
    JSON.stringify({
      version: 1,
      entries: {
        'enemy::goblin': {
          briefId: 'goblin',
          assetPath: 'generated/goblin.png',
          sourceRun: 'runs/enemy-goblin/2026-07-02T21-45-32-1de0721b',
          variantIndex: 0,
        },
        'weapon::sword': {
          briefId: 'sword',
          assetPath: 'generated/sword.png',
          sourceRun: 'placeholder',
          variantIndex: 0,
        },
      },
    }),
  );
});
after(() => rmSync(root, { recursive: true, force: true }));

test('loadBacklog (registry available) resolves integration and collects promoted run ids', () => {
  const backlog = loadBacklog({
    repoRoot: root,
    spriteIds: new Set(['enemy_goblin']),
    itemIds: new Set(),
  });
  assert.equal(backlog.integrationResolved, true);
  assert.equal(backlog.planCount, 1);
  const report = backlog.reports[0];
  const goblin = report.assets.find((a) => a.id === 'goblin');
  assert.equal(goblin.status, 'ready');
  // promoted run key = last TWO segments of the non-placeholder sourceRun
  // (`<briefId>/<runId>`, backslash-normalized), matching the sidecar's canonical
  // keying; the runId-alone key is NOT present and the placeholder contributes nothing.
  assert.ok(backlog.promotedRunIds.has('enemy-goblin/2026-07-02T21-45-32-1de0721b'));
  assert.equal(backlog.promotedRunIds.has('2026-07-02T21-45-32-1de0721b'), false);
  assert.equal(backlog.promotedRunIds.has('placeholder'), false);
  // Totals cover every status bucket including the canvas-only one.
  for (const status of ALL_STATUSES) assert.ok(status in backlog.totals);
});

test('loadBacklog (registry unavailable) sets integrationResolved false + unverified', () => {
  const backlog = loadBacklog({ repoRoot: root, spriteIds: null, itemIds: null });
  assert.equal(backlog.integrationResolved, false);
  const goblin = backlog.reports[0].assets.find((a) => a.id === 'goblin');
  assert.equal(goblin.integrationState, 'unverified');
  assert.equal(goblin.status, 'approved-unverified');
});

test('loadBacklog degrades to an empty backlog for a repo with no plans', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'workflow-empty-'));
  try {
    const backlog = loadBacklog({ repoRoot: empty, spriteIds: new Set(), itemIds: new Set() });
    assert.equal(backlog.planCount, 0);
    assert.deepEqual(backlog.reports, []);
    assert.equal(backlog.promotedRunIds.size, 0);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test('loadBacklog normalizes Windows-style sourceRun into the two-segment promoted key', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'workflow-winpath-'));
  try {
    mkdirSync(path.join(root, 'public', 'assets', 'generated'), { recursive: true });
    writeFileSync(path.join(root, 'public', 'assets', 'generated', 'orc.png'), 'png');
    writeFileSync(
      path.join(root, 'public', 'assets', 'generated', 'manifest.json'),
      JSON.stringify({
        version: 1,
        entries: {
          'enemy::orc': {
            briefId: 'orc',
            assetPath: 'generated/orc.png',
            // Backslash-separated path as produced on Windows: must be normalized
            // and keyed by the last TWO segments, matching the sidecar.
            sourceRun: 'runs\\enemy-orc\\2026-07-05T10-11-12-abcd1234',
            variantIndex: 0,
          },
        },
      }),
    );
    const backlog = loadBacklog({ repoRoot: root, spriteIds: new Set(), itemIds: new Set() });
    assert.ok(backlog.promotedRunIds.has('enemy-orc/2026-07-05T10-11-12-abcd1234'));
    // The un-normalized backslash string must NOT leak through as a key.
    assert.equal(
      backlog.promotedRunIds.has('runs\\enemy-orc\\2026-07-05T10-11-12-abcd1234'),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
