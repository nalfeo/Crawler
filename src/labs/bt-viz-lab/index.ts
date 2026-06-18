/**
 * Behavior Tree Visualization Lab
 *
 * Visual debugging and monitoring of AI behavior trees.
 * Shows live tree structure, node states, and decision-making in real-time.
 */

import { MainGameScene } from '../../engine/scenes/MainGameScene.js';
import type { LabDefinition } from '../registry.js';
import { BehaviorTreeAI } from '../../game/ai/bt-ai-provider.js';
import type { SerializedBTNode } from '../../game/ai/behavior-tree.js';
import { createLogger } from '../../shared/logger.js';

const logger = createLogger('lab:bt-viz');

/**
 * Render a behavior tree visualization to the controls panel.
 */
function renderBehaviorTree(
  container: HTMLElement,
  tree: SerializedBTNode,
  decision: { state: number; reason: string; targetX: number | null; targetY: number | null },
): void {
  // Clear previous render
  container.innerHTML = '';

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding: 10px; background: #222; border-bottom: 1px solid #444;';
  header.innerHTML = '<h3 style="margin:0; color: #fff;">Behavior Tree Visualization</h3>';
  container.appendChild(header);

  // Decision state
  const stateDiv = document.createElement('div');
  stateDiv.style.cssText = 'padding: 10px; background: #333; border-bottom: 1px solid #444;';
  const stateName =
    ['EXPLORE', 'ENGAGE', 'RETREAT', 'COLLECT', 'INTERACT'][decision.state] || 'UNKNOWN';
  stateDiv.innerHTML = `
    <div style="color: #fff; font-weight: bold;">Current State: <span style="color: #4fc3f7;">${stateName}</span></div>
    <div style="color: #aaa; font-size: 12px; margin-top: 4px;">Reason: ${decision.reason}</div>
    ${decision.targetX !== null ? `<div style="color: #aaa; font-size: 12px;">Target: (${Math.round(decision.targetX)}, ${Math.round(decision.targetY || 0)})</div>` : ''}
  `;
  container.appendChild(stateDiv);

  // Tree structure
  const treeContainer = document.createElement('div');
  treeContainer.style.cssText =
    'padding: 10px; overflow-y: auto; max-height: 500px; background: #1e1e1e;';
  container.appendChild(treeContainer);

  // Recursively render tree nodes
  function renderNode(node: SerializedBTNode, depth: number, parentEl: HTMLElement): void {
    const nodeDiv = document.createElement('div');
    nodeDiv.style.cssText = `
      margin-left: ${depth * 20}px;
      padding: 4px 8px;
      margin-top: 4px;
      border-left: 2px solid ${getNodeColor(node.type)};
      background: ${depth % 2 === 0 ? '#2a2a2a' : '#252525'};
      font-family: monospace;
      font-size: 12px;
      color: #fff;
    `;

    const typeSpan = document.createElement('span');
    typeSpan.style.cssText = `color: ${getNodeColor(node.type)}; font-weight: bold;`;
    typeSpan.textContent = `[${node.type}] `;

    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'color: #ddd;';
    nameSpan.textContent = node.name;

    nodeDiv.appendChild(typeSpan);
    nodeDiv.appendChild(nameSpan);
    parentEl.appendChild(nodeDiv);

    // Render children
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        renderNode(child, depth + 1, parentEl);
      }
    }
  }

  function getNodeColor(type: string): string {
    switch (type) {
      case 'Sequence':
        return '#4caf50'; // Green
      case 'Selector':
        return '#ff9800'; // Orange
      case 'Condition':
        return '#2196f3'; // Blue
      case 'Action':
        return '#f44336'; // Red
      case 'Inverter':
      case 'Succeeder':
      case 'Repeat':
        return '#9c27b0'; // Purple
      default:
        return '#888';
    }
  }

  renderNode(tree, 0, treeContainer);

  // Legend
  const legend = document.createElement('div');
  legend.style.cssText =
    'padding: 10px; background: #222; border-top: 1px solid #444; font-size: 11px;';
  legend.innerHTML = `
    <div style="color: #fff; font-weight: bold; margin-bottom: 6px;">Legend:</div>
    <div style="color: ${getNodeColor('Sequence')};">■ Sequence - Execute children in order (AND)</div>
    <div style="color: ${getNodeColor('Selector')};">■ Selector - Try children until one succeeds (OR)</div>
    <div style="color: ${getNodeColor('Condition')};">■ Condition - Test a boolean condition</div>
    <div style="color: ${getNodeColor('Action')};">■ Action - Execute a behavior</div>
    <div style="color: ${getNodeColor('Inverter')};">■ Decorator - Modify child behavior</div>
  `;
  container.appendChild(legend);
}

export default {
  id: 'bt-viz',
  name: 'Behavior Tree Visualization',
  description: 'Visualize and debug AI behavior trees in real-time',

  create: (canvas: HTMLElement, controls: HTMLElement) => {
    logger.info('Starting Behavior Tree Visualization Lab');

    // Create AI instance
    const ai = new BehaviorTreeAI({
      seed: 54321,
      debug: true,
    });

    // Style controls panel
    controls.style.cssText = `
      background: #1e1e1e;
      color: #fff;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      overflow-y: auto;
    `;

    // Create scene with AI
    const scene = new MainGameScene({
      canvas,
      testMode: false,
      aiInputProvider: ai,
    });

    // Initial render
    const tree = ai.getTree().serialize();
    const decision = ai.getDecision();
    renderBehaviorTree(controls, tree, decision);

    // Update visualization every frame
    let frameCount = 0;
    const updateInterval = setInterval(() => {
      frameCount++;
      // Update every 10 frames (roughly 6 times per second at 60 FPS)
      if (frameCount % 10 === 0) {
        const currentTree = ai.getTree().serialize();
        const currentDecision = ai.getDecision();
        renderBehaviorTree(controls, currentTree, currentDecision);
      }
    }, 16); // Roughly 60 FPS

    // Cleanup
    return () => {
      clearInterval(updateInterval);
      scene.destroy();
      logger.info('Behavior Tree Visualization Lab stopped');
    };
  },
};
