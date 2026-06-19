/**
 * Behavior Tree implementation for AI decision-making.
 *
 * Industry-standard composable behavior tree system with:
 * - Sequence nodes (AND logic)
 * - Selector nodes (OR logic)
 * - Condition nodes (tests)
 * - Action nodes (behaviors)
 * - Decorator nodes (modifiers)
 */

import type { GameWorld } from '../../core/world.js';

/**
 * Behavior tree node execution status.
 */
export enum BTStatus {
  /** Node succeeded */
  SUCCESS = 'SUCCESS',
  /** Node failed */
  FAILURE = 'FAILURE',
  /** Node is still running (multi-frame actions) */
  RUNNING = 'RUNNING',
}

/**
 * Context passed to all behavior tree nodes.
 * Contains world state and shared blackboard for inter-node communication.
 */
export interface BTContext {
  /** Game world state */
  world: GameWorld;
  /** Player entity ID */
  playerEid: number;
  /** Player position */
  playerX: number;
  playerY: number;
  /** Player health percentage (0-1) */
  healthPercent: number;
  /** Shared data between nodes (blackboard pattern) */
  blackboard: Record<string, unknown>;
}

/**
 * Base interface for all behavior tree nodes.
 */
export interface BTNode {
  /** Execute this node and return status */
  tick(context: BTContext): BTStatus;
  /** Get human-readable name for debugging */
  getName(): string;
  /** Get node type for visualization */
  getType(): string;
  /** Get children nodes (for composite nodes) */
  getChildren(): BTNode[];
}

/**
 * Abstract base class for behavior tree nodes.
 */
export abstract class BTNodeBase implements BTNode {
  constructor(protected readonly name: string) {}

  abstract tick(context: BTContext): BTStatus;

  getName(): string {
    return this.name;
  }

  abstract getType(): string;

  getChildren(): BTNode[] {
    return [];
  }
}

/**
 * Sequence node: executes children in order until one fails.
 * Returns SUCCESS if all children succeed.
 * Returns FAILURE if any child fails.
 * Like AND logic.
 */
export class BTSequence extends BTNodeBase {
  private currentIndex: number = 0;

  constructor(
    name: string,
    private readonly children: BTNode[],
  ) {
    super(name);
  }

  tick(context: BTContext): BTStatus {
    // Execute children sequentially
    while (this.currentIndex < this.children.length) {
      const child = this.children[this.currentIndex];
      if (!child) {
        this.currentIndex = 0;
        return BTStatus.FAILURE;
      }

      const status = child.tick(context);

      if (status === BTStatus.FAILURE) {
        this.currentIndex = 0;
        return BTStatus.FAILURE;
      }

      if (status === BTStatus.RUNNING) {
        return BTStatus.RUNNING;
      }

      // SUCCESS - move to next child
      this.currentIndex++;
    }

    // All children succeeded
    this.currentIndex = 0;
    return BTStatus.SUCCESS;
  }

  getType(): string {
    return 'Sequence';
  }

  getChildren(): BTNode[] {
    return this.children;
  }
}

/**
 * Selector node: executes children in order until one succeeds.
 * Returns SUCCESS if any child succeeds.
 * Returns FAILURE if all children fail.
 * Like OR logic.
 */
export class BTSelector extends BTNodeBase {
  private currentIndex: number = 0;

  constructor(
    name: string,
    private readonly children: BTNode[],
  ) {
    super(name);
  }

  tick(context: BTContext): BTStatus {
    // Try children sequentially
    while (this.currentIndex < this.children.length) {
      const child = this.children[this.currentIndex];
      if (!child) {
        this.currentIndex = 0;
        return BTStatus.FAILURE;
      }

      const status = child.tick(context);

      if (status === BTStatus.SUCCESS) {
        this.currentIndex = 0;
        return BTStatus.SUCCESS;
      }

      if (status === BTStatus.RUNNING) {
        return BTStatus.RUNNING;
      }

      // FAILURE - try next child
      this.currentIndex++;
    }

    // All children failed
    this.currentIndex = 0;
    return BTStatus.FAILURE;
  }

  getType(): string {
    return 'Selector';
  }

  getChildren(): BTNode[] {
    return this.children;
  }
}

/**
 * Condition node: evaluates a boolean condition.
 * Returns SUCCESS if condition is true, FAILURE otherwise.
 */
export class BTCondition extends BTNodeBase {
  constructor(
    name: string,
    private readonly condition: (context: BTContext) => boolean,
  ) {
    super(name);
  }

  tick(context: BTContext): BTStatus {
    return this.condition(context) ? BTStatus.SUCCESS : BTStatus.FAILURE;
  }

  getType(): string {
    return 'Condition';
  }
}

/**
 * Action node: executes a behavior.
 * Can return SUCCESS, FAILURE, or RUNNING.
 */
export class BTAction extends BTNodeBase {
  constructor(
    name: string,
    private readonly action: (context: BTContext) => BTStatus,
  ) {
    super(name);
  }

  tick(context: BTContext): BTStatus {
    return this.action(context);
  }

  getType(): string {
    return 'Action';
  }
}

/**
 * Decorator base class: wraps a single child node and modifies its behavior.
 */
export abstract class BTDecorator extends BTNodeBase {
  constructor(
    name: string,
    protected readonly child: BTNode,
  ) {
    super(name);
  }

  getChildren(): BTNode[] {
    return [this.child];
  }
}

/**
 * Inverter decorator: inverts the result of the child node.
 * SUCCESS -> FAILURE
 * FAILURE -> SUCCESS
 * RUNNING -> RUNNING
 */
export class BTInverter extends BTDecorator {
  tick(context: BTContext): BTStatus {
    const status = this.child.tick(context);
    if (status === BTStatus.SUCCESS) return BTStatus.FAILURE;
    if (status === BTStatus.FAILURE) return BTStatus.SUCCESS;
    return BTStatus.RUNNING;
  }

  getType(): string {
    return 'Inverter';
  }
}

/**
 * Succeeder decorator: always returns SUCCESS regardless of child result.
 */
export class BTSucceeder extends BTDecorator {
  tick(context: BTContext): BTStatus {
    this.child.tick(context);
    return BTStatus.SUCCESS;
  }

  getType(): string {
    return 'Succeeder';
  }
}

/**
 * Repeat decorator: repeats the child node N times or until it fails.
 */
export class BTRepeat extends BTDecorator {
  private currentCount: number = 0;

  constructor(
    name: string,
    child: BTNode,
    private readonly maxCount: number = Infinity,
  ) {
    super(name, child);
  }

  tick(context: BTContext): BTStatus {
    if (this.currentCount >= this.maxCount) {
      this.currentCount = 0;
      return BTStatus.SUCCESS;
    }

    const status = this.child.tick(context);

    if (status === BTStatus.FAILURE) {
      this.currentCount = 0;
      return BTStatus.FAILURE;
    }

    if (status === BTStatus.SUCCESS) {
      this.currentCount++;
      if (this.currentCount >= this.maxCount) {
        this.currentCount = 0;
        return BTStatus.SUCCESS;
      }
      return BTStatus.RUNNING;
    }

    return BTStatus.RUNNING;
  }

  getType(): string {
    return 'Repeat';
  }
}

/**
 * Behavior Tree root.
 */
export class BehaviorTree {
  constructor(private readonly root: BTNode) {}

  /**
   * Execute one tick of the behavior tree.
   */
  tick(context: BTContext): BTStatus {
    return this.root.tick(context);
  }

  /**
   * Get the root node for visualization.
   */
  getRoot(): BTNode {
    return this.root;
  }

  /**
   * Serialize the tree structure for debugging/visualization.
   */
  serialize(): SerializedBTNode {
    return serializeNode(this.root);
  }
}

/**
 * Serialized node format for visualization.
 */
export interface SerializedBTNode {
  name: string;
  type: string;
  children: SerializedBTNode[];
}

/**
 * Recursively serialize a behavior tree node.
 */
function serializeNode(node: BTNode): SerializedBTNode {
  return {
    name: node.getName(),
    type: node.getType(),
    children: node.getChildren().map((child) => serializeNode(child)),
  };
}

/**
 * Factory functions for building behavior trees.
 */

export function sequence(name: string, ...children: BTNode[]): BTSequence {
  return new BTSequence(name, children);
}

export function selector(name: string, ...children: BTNode[]): BTSelector {
  return new BTSelector(name, children);
}

export function condition(name: string, fn: (context: BTContext) => boolean): BTCondition {
  return new BTCondition(name, fn);
}

export function action(name: string, fn: (context: BTContext) => BTStatus): BTAction {
  return new BTAction(name, fn);
}

export function inverter(name: string, child: BTNode): BTInverter {
  return new BTInverter(name, child);
}

export function succeeder(name: string, child: BTNode): BTSucceeder {
  return new BTSucceeder(name, child);
}

export function repeat(name: string, child: BTNode, count: number = Infinity): BTRepeat {
  return new BTRepeat(name, child, count);
}
