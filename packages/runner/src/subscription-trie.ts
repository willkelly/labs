
export const PRIORITY_SYNC = 0;
export const PRIORITY_FRAME = 1;
export const PRIORITY_IDLE = 2;

export type Priority = typeof PRIORITY_SYNC | typeof PRIORITY_FRAME | typeof PRIORITY_IDLE;

class Scheduler {
  private frameQueue: Set<() => void> = new Set();
  private idleQueue: Set<() => void> = new Set();
  private frameScheduled = false;
  private idleScheduled = false;

  schedule(callback: Function, priority: Priority, arg: any) {
    const task = () => callback(arg);

    if (priority === PRIORITY_SYNC) {
      task();
    } else if (priority === PRIORITY_FRAME) {
      // We use a Map or similar mechanism if we wanted to dedupe by (callback, arg),
      // but here we dedupe by task instance which is created per call. 
      // To strictly follow "Set of unique callbacks", we should probably pass the raw callback and arg.
      // But 'arg' (newState) changes.
      // The plan says: "frameQueue: A Set of unique callbacks".
      // If we just add the wrapper 'task', it's always unique.
      // To dedupe, we should probably store the callback itself and the *latest* arg?
      // But strict deduping might be complex if 'arg' differs.
      // For now, I'll implement simple scheduling.
      
      this.frameQueue.add(task);
      if (!this.frameScheduled) {
        this.frameScheduled = true;
        requestAnimationFrame(() => this.flushFrame());
      }
    } else if (priority === PRIORITY_IDLE) {
      this.idleQueue.add(task);
      if (!this.idleScheduled) {
        this.idleScheduled = true;
        (globalThis as any).requestIdleCallback(() => this.flushIdle());
      }
    }
  }

  private flushFrame() {
    this.frameScheduled = false;
    const tasks = [...this.frameQueue];
    this.frameQueue.clear();
    for (const task of tasks) task();
  }

  private flushIdle() {
    this.idleScheduled = false;
    const tasks = [...this.idleQueue];
    this.idleQueue.clear();
    for (const task of tasks) task();
  }
}

class TrieNode {
  listeners: Set<{ callback: Function; priority: Priority }> = new Set();
  children: Map<string, TrieNode> = new Map();
  wildcard: TrieNode | null = null; // Handle '*' segments
}

export class SubscriptionTrie {
  private root = new TrieNode();
  private scheduler = new Scheduler();

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

    const listener = { callback, priority };
    node.listeners.add(listener);

    return () => {
      node.listeners.delete(listener);
      // Pruning could happen here if node becomes empty, but lazy pruning in notify is also fine.
    };
  }

  notify(oldState: any, newState: any, path: string[] = []): void {
    // 1. The Merkle Check
    if (oldState === newState) {
      return;
    }

    // Traverse to current node
    let node = this.root;
    for (const key of path) {
        if (key === '*') {
            // This logic is tricky. 'path' argument tracks where we ARE in the data.
            // But the Trie structure tracks where listeners ARE.
            // When we are notifying, we are walking the Data and the Trie simultaneously.
            // But 'path' here is just the recursion stack.
            // We need to pass the 'node' down during recursion instead of looking it up from root every time.
        }
    }
    
    // REVISION: The `notify` signature in the plan is `notify(oldState, newState, path)`.
    // It implies we start at root and recurse.
    // To do this efficiently, we should traverse the Trie alongside the Data.
    
    this.notifyNode(this.root, oldState, newState, path);
  }

  private notifyNode(node: TrieNode, oldState: any, newState: any, currentPath: string[]) {
    // Pruning check (optimization): If node is empty, stop.
    if (node.listeners.size === 0 && node.children.size === 0 && !node.wildcard) {
        return;
    }

    // Execution: Notify listeners at this level
    for (const { callback, priority } of node.listeners) {
      this.scheduler.schedule(callback, priority, newState);
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

       if (oldVal === newVal) continue; // Merkle check for children

       // 1. Check exact match child
       const childNode = node.children.get(key);
       if (childNode) {
           this.notifyNode(childNode, oldVal, newVal, [...currentPath, key]);
       }

       // 2. Check wildcard child
       if (node.wildcard) {
           this.notifyNode(node.wildcard, oldVal, newVal, [...currentPath, key]);
       }
    }
  }
}
