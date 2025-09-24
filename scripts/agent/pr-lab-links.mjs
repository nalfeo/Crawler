#!/usr/bin/env node
/**
 * pr-lab-links.mjs
 *
 * Given a JSON array of changed file paths on stdin, outputs a JSON array of
 * relevant lab IDs (excluding 'ai-runner', which is always shown separately).
 *
 * Detection strategy:
 *   1. Direct: file under src/labs/<dir>/ → the lab for that directory
 *   2. Import scan: for each changed non-lab source file, scan every lab's
 *      index.ts for an import referencing that file by base name
 *
 * Usage:
 *   echo '["src/labs/weapon-lab/index.ts","src/game/weaponSystem.ts"]' \
 *     | node scripts/agent/pr-lab-links.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..', '..');
const LABS_DIR = resolve(ROOT, 'src', 'labs');

/** Parse LAB_MODULE_PATHS from src/lab-main.ts → { labId: '/src/labs/<dir>/index.ts' } */
function parseLabModulePaths() {
  try {
    const content = readFileSync(resolve(ROOT, 'src', 'lab-main.ts'), 'utf-8');
    const result = {};
    const re = /'([^']+)':\s*'(\/src\/labs\/[^']+)'/g;
    let m;
    while ((m = re.exec(content)) !== null) {
      result[m[1]] = m[2];
    }
    return result;
  } catch {
    return {};
  }
}

/** Build a map from relative dir path → lab ID, e.g. 'src/labs/ai-runner-lab' → 'ai-runner' */
function buildDirToLabIdMap(labModulePaths) {
  const map = {};
  for (const [id, path] of Object.entries(labModulePaths)) {
    // path looks like '/src/labs/ai-runner-lab/index.ts'
    const match = path.match(/^\/src\/labs\/([^/]+)\//);
    if (match) {
      map[`src/labs/${match[1]}`] = id;
    }
  }
  return map;
}

/** Load every lab's index.ts content keyed by directory name */
function loadLabContents() {
  const contents = {};
  try {
    for (const dir of readdirSync(LABS_DIR)) {
      const indexPath = resolve(LABS_DIR, dir, 'index.ts');
      if (existsSync(indexPath)) {
        try {
          contents[dir] = readFileSync(indexPath, 'utf-8');
        } catch {
          // ignore unreadable files
        }
      }
    }
  } catch {
    // ignore if labs dir is missing
  }
  return contents;
}

/**
 * Returns true if labContent contains an import path ending with /<baseName>[.js|.ts].
 * Matches patterns like: from '../../core/systems/movementSystem.js'
 */
function labReferencesFile(labContent, baseName) {
  const re = new RegExp(`from\\s+['"][^'"]*/${baseName}(?:\\.(?:js|ts))?['"]`);
  return re.test(labContent);
}

const labModulePaths = parseLabModulePaths();
const dirToLabId = buildDirToLabIdMap(labModulePaths);
const knownLabIds = new Set(Object.keys(labModulePaths));

/**
 * Static mapping: source file path substring → lab IDs that are relevant when
 * files at those paths change.  Labs are listed by their lab-main.ts key.
 * Keeps the import-scan pass honest for labs that use barrel imports.
 */
const SOURCE_PATH_TO_LABS = {
  // AI systems
  'src/game/ai/': ['enemy-ai-lab', 'bt-viz'],
  'src/game/enemyAISystem': ['enemy-ai-lab'],
  'src/game/enemySpawner': ['enemy-ai-lab'],
  // Weapon systems
  'src/game/weaponSystem': ['weapon-lab'],
  'src/core/systems/beamSystem': ['weapon-lab'],
  'src/core/systems/meleeSwingSystem': ['weapon-lab'],
  'src/core/systems/trapSystem': ['weapon-lab'],
  'src/core/systems/aoeOnImpactSystem': ['weapon-lab'],
  'src/core/systems/areaDamageSystem': ['weapon-lab'],
  'src/core/systems/returningProjectileSystem': ['weapon-lab'],
  'src/core/systems/projectileCleanupSystem': ['projectilecleanup-lab', 'weapon-lab'],
  // Movement & input
  'src/core/systems/movementSystem': ['movement-lab'],
  'src/core/systems/playerInputSystem': ['playerinput-lab', 'movement-lab'],
  'src/core/systems/knockbackSystem': ['knockback-lab'],
  'src/engine/controls': ['mobile-controls-lab'],
  // Combat / health
  'src/core/systems/damageSystem': ['damage-lab', 'weapon-lab'],
  'src/core/systems/healthSystem': ['health-lab'],
  'src/core/apply-damage': ['damage-lab', 'weapon-lab'],
  'src/core/systems/deathTimerSystem': ['deathtimer-lab'],
  // Collision & physics
  'src/core/collision': ['collision-lab'],
  // Inventory & items
  'src/core/systems/itemPickupSystem': ['itempickup-lab'],
  'src/core/systems/harvestSystem': ['harvest-lab'],
  'src/shared/harvestableDefs': ['harvest-lab'],
  'src/core/systems/dropSystem': ['drop-lab', 'gore-lab'],
  'src/core/systems/equipmentSystem': ['equipment-lab'],
  'src/game/ai/equipment-evaluator': ['equipment-evaluator'],
  'src/game/systems/statsSystem': ['stats-lab', 'stat-lab'],
  'src/core/systems/statSystem': ['stat-lab'],
  'src/core/systems/lifetimeSystem': ['lifetime-lab'],
  // Progression
  'src/game/systems/levelSystem': ['level-up-lab'],
  'src/game/systems/skillSystem': ['skill-lab'],
  'src/game/skills/': ['skill-lab'],
  'src/game/abilities/': ['skill-lab'],
  // World / map
  'src/core/systems/doorSystem': ['door-lab', 'door-lock-lab'],
  'src/core/door-lock': ['door-lock-lab'],
  'src/core/systems/fovSystem': ['fov-lab'],
  // Entities
  'src/core/systems/npcSystem': ['npc-lab'],
  'src/core/systems/questSystem': ['quest-lab'],
  // Props / decoration
  'src/game/systems/propPlacer': ['prop-lab'],
  'src/shared/decorationDefs': ['prop-lab'],
  // Engine / rendering
  'src/engine/terrain': ['map-gen-lab', 'terrain-pack-lab'],
  'src/engine/sprites/tile': ['map-gen-lab', 'tile-explorer'],
  'src/engine/sprites/terrain-pack': ['terrain-pack-lab'],
  'src/shared/terrain-pack': ['terrain-pack-lab'],
  'src/engine/GoreVfx': ['gore-lab'],
  'src/engine/hud': ['hud-lab'],
  // Shared
  'src/shared/sprite-catalog': ['sprite-catalog'],
  'src/shared/weaponDefs': ['weapon-lab'],
  'src/shared/quest-types': ['quest-lab', 'quest-content-lab'],
  'src/core/components': ['weapon-lab', 'movement-lab'],
};

// Read changed files from stdin
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  let changedFiles;
  try {
    changedFiles = JSON.parse(input.trim());
    if (!Array.isArray(changedFiles)) changedFiles = [];
  } catch {
    process.stdout.write('[]');
    process.exit(0);
  }

  const relevantIds = new Set();
  const nonLabSourceFiles = [];

  // Pass 1: detect direct lab directory changes
  for (const filePath of changedFiles) {
    let foundLab = false;
    for (const [dir, id] of Object.entries(dirToLabId)) {
      if (filePath.startsWith(dir + '/') || filePath === dir) {
        relevantIds.add(id);
        foundLab = true;
        break;
      }
    }
    if (!foundLab && filePath.startsWith('src/') && !filePath.startsWith('src/labs/')) {
      nonLabSourceFiles.push(filePath);
    }
  }

  // Pass 2a: static source-path mapping
  for (const filePath of nonLabSourceFiles) {
    for (const [prefix, labIds] of Object.entries(SOURCE_PATH_TO_LABS)) {
      if (filePath.includes(prefix)) {
        for (const id of labIds) {
          if (knownLabIds.has(id)) relevantIds.add(id);
        }
      }
    }
  }

  // Pass 2b: import scan — find labs that directly import the changed source files
  // (catches cases not covered by the static map, e.g. new labs added after this script)
  if (nonLabSourceFiles.length > 0) {
    const labContents = loadLabContents();

    for (const filePath of nonLabSourceFiles) {
      const baseName = basename(filePath, extname(filePath));
      // Skip index files and very short names to avoid false positives
      if (baseName === 'index' || baseName.length < 5) continue;

      for (const [dir, content] of Object.entries(labContents)) {
        const labId = dirToLabId[`src/labs/${dir}`];
        if (!labId || !knownLabIds.has(labId)) continue;
        if (relevantIds.has(labId)) continue;

        if (labReferencesFile(content, baseName)) {
          relevantIds.add(labId);
        }
      }
    }
  }

  // ai-runner is always shown separately in the comment; exclude it from "related labs"
  relevantIds.delete('ai-runner');

  process.stdout.write(JSON.stringify([...relevantIds]));
  process.exit(0);
});
