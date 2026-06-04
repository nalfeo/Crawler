import './labs/index.js';
import './labs/combat-lab/index.js';
import './labs/collision-lab/index.js';
import './labs/damage-lab/index.js';
import './labs/health-lab/index.js';
import './labs/hello-world/index.js';
import './labs/movement-lab/index.js';
import './labs/playerinput-lab/index.js';
import './labs/projectilecleanup-lab/index.js';
import './labs/enemy-ai-lab/index.js';
import './labs/inventory-lab/index.js';
import './labs/itempickup-lab/index.js';
import './labs/knockback-lab/index.js';
import './labs/lifetime-lab/index.js';
import './labs/weapons-lab/index.js';
import './labs/equipment-lab/index.js';
import './labs/stat-lab/index.js';
import './labs/stats-lab/index.js';
import './labs/xp-curve-lab/index.js';
import './labs/skill-lab/index.js';
import { renderLabIndex } from './labs/lab-index.js';
import { runLab } from './labs/lab-runner.js';

const labId = new URLSearchParams(window.location.search).get('lab');

if (labId) {
  runLab(labId);
} else {
  renderLabIndex();
}
