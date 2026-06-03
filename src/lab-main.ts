import './labs/index.js';
import './labs/hello-world/index.js';
import { renderLabIndex } from './labs/lab-index.js';
import { runLab } from './labs/lab-runner.js';

const labId = new URLSearchParams(window.location.search).get('lab');

if (labId) {
  runLab(labId);
} else {
  renderLabIndex();
}
