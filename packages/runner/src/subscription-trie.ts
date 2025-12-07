import { deepEqual } from "./path-utils.ts";

export const PRIORITY_SYNC = 0;
export const PRIORITY_FRAME = 1;
export const PRIORITY_IDLE = 2;

export type Priority = typeof PRIORITY_SYNC | typeof PRIORITY_FRAME | typeof PRIORITY_IDLE;

/**
 * Metrics for tracking notification efficiency.
 * Compare with/without interning to see the optimization impact.
 */
export interface TrieMetrics {
  /** Total notify() / notifyAtPath() calls */
  notifyCalls: number;
  /** Total trie nodes visited during notification */
  nodesVisited: number;
  /** Subtrees skipped due to === reference equality (Merkle optimization) */
  subtreesSkipped: number;
  /** Total listeners/actions triggered */
  actionsTriggered: number;
}

class TrieNode {
  listeners: Set<Function> = new Set();
  children: Map<string, TrieNode> = new Map();
  wildcard: TrieNode | null = null; // Handle '*' segments
}

export class SubscriptionTrie {
  private root = new TrieNode();

  /** Metrics for measuring notification efficiency */
  metrics: TrieMetrics = {
    notifyCalls: 0,
    nodesVisited: 0,
    subtreesSkipped: 0,
    actionsTriggered: 0,
  };

  /** Reset metrics counters */
  resetMetrics(): void {
    this.metrics = {
      notifyCalls: 0,
      nodesVisited: 0,
      subtreesSkipped: 0,
      actionsTriggered: 0,
    };
  }

  subscribe(path: string[], callback: Function, priority: Priority = PRIORITY_SYNC): () => void {
    let node = this.root;
    for (const key of path) {
      if (key === '*') {
        if (!node.wildcard) {
          node.wildcard = new TrieNode();
        }
        node = node.wildcard;
      } else {
        if (!node.children.has(key)) {
          node.children.set(key, new TrieNode());
        }
        node = node.children.get(key)!;
      }
    }

    node.listeners.add(callback);

    return () => {
      node.listeners.delete(callback);
    };
  }

  notify(oldState: any, newState: any, onTrigger: (callback: Function) => void): void {
    this.metrics.notifyCalls++;

    // With interning, identical states have the same reference
    if (oldState === newState) {
      this.metrics.subtreesSkipped++;
      return;
    }

    this.notifyNode(this.root, oldState, newState, [], onTrigger);
  }

  /**
   * Notify about a change at a specific path.
   * - Notifies all ancestor listeners (data at their path changed because a descendant changed)
   * - Notifies listeners at the exact path if before !== after
   * - Recursively notifies descendant listeners for changed sub-paths
   */
  notifyAtPath(
    changePath: string[],
    oldState: any,
    newState: any,
    onTrigger: (callback: Function) => void
  ): void {
    this.metrics.notifyCalls++;

    // Use Merkle check if available (reference equality)
    if (oldState === newState) {
      this.metrics.subtreesSkipped++;
      return;
    }

    // If changePath is empty, the change is at the root - use full notify
    if (changePath.length === 0) {
      // Don't double-count notifyCalls - notify() will increment it
      this.metrics.notifyCalls--;
      this.notify(oldState, newState, onTrigger);
      return;
    }

    // Collect all triggered actions to dedupe
    const triggered = new Set<Function>();
    const triggerOnce = (cb: Function) => {
      if (!triggered.has(cb)) {
        triggered.add(cb);
        onTrigger(cb);
      }
    };

    // Walk from root to changePath, notifying ancestors and traversing state
    let node = this.root;
    let oldAtPath = oldState;
    let newAtPath = newState;

    for (const key of changePath) {
      // Notify listeners at this ancestor level (their data changed via a descendant)
      for (const callback of node.listeners) {
        triggerOnce(callback);
      }

      // Navigate to next node
      const childNode = node.children.get(key);
      if (!childNode) {
        // No subscriptions at or below this path
        return;
      }
      node = childNode;

      // Also traverse state to match the path
      oldAtPath = oldAtPath && typeof oldAtPath === 'object' ? oldAtPath[key] : undefined;
      newAtPath = newAtPath && typeof newAtPath === 'object' ? newAtPath[key] : undefined;
    }

    // Now at the changePath node - notify and recurse into descendants
    // Use the values AT the changePath, not the full state
    this.notifyNode(node, oldAtPath, newAtPath, changePath, triggerOnce);
  }

  private notifyNode(node: TrieNode, oldState: any, newState: any, currentPath: string[], onTrigger: (callback: Function) => void) {
    this.metrics.nodesVisited++;

    // Pruning check (optimization): If node is empty, stop.
    if (node.listeners.size === 0 && node.children.size === 0 && !node.wildcard) {
        return;
    }

    // Execution: Notify listeners at this level
    for (const callback of node.listeners) {
      this.metrics.actionsTriggered++;
      onTrigger(callback);
    }

    // Recursion
    // We need to iterate over keys in BOTH oldState and newState.

    const keys = new Set<string>();
    if (oldState && typeof oldState === 'object') {
        Object.keys(oldState).forEach(k => keys.add(k));
    }
    if (newState && typeof newState === 'object') {
        Object.keys(newState).forEach(k => keys.add(k));
    }

    for (const key of keys) {
       const oldVal = oldState ? oldState[key] : undefined;
       const newVal = newState ? newState[key] : undefined;

       // Skip if values are the same reference (with interning, identical content = same ref)
       if (oldVal === newVal) {
         this.metrics.subtreesSkipped++;
         continue;
       }

       // 1. Check exact match child
       const childNode = node.children.get(key);
       if (childNode) {
           this.notifyNode(childNode, oldVal, newVal, [...currentPath, key], onTrigger);
       }

       // 2. Check wildcard child
       if (node.wildcard) {
           this.notifyNode(node.wildcard, oldVal, newVal, [...currentPath, key], onTrigger);
       }
    }
  }
}
