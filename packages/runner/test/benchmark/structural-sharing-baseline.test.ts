/**
 * Structural Sharing Baseline Benchmarks
 *
 * Run BEFORE and AFTER implementing structural sharing to measure improvement.
 *
 * Metrics measured:
 * - deepEqual fast path hit rate (a === b triggers)
 * - JSON.stringify calls during change detection
 * - Memory for similar documents
 * - Notification count (must stay SAME for correctness)
 *
 * Run with: deno test -A packages/runner/test/benchmark/structural-sharing-baseline.test.ts
 */

import { describe, it, beforeAll, afterAll, beforeEach } from "@std/testing/bdd";
import { expect } from "@std/expect";

// ============================================================================
// Instrumentation
// ============================================================================

interface Metrics {
  jsonStringifyCalls: number;
  deepEqualCalls: number;
  deepEqualFastPathHits: number;
  notificationCount: number;
}

const metrics: Metrics = {
  jsonStringifyCalls: 0,
  deepEqualCalls: 0,
  deepEqualFastPathHits: 0,
  notificationCount: 0,
};

function resetMetrics() {
  metrics.jsonStringifyCalls = 0;
  metrics.deepEqualCalls = 0;
  metrics.deepEqualFastPathHits = 0;
  metrics.notificationCount = 0;
}

// ============================================================================
// Instrumented deepEqual (copy of path-utils.ts implementation with tracking)
// ============================================================================

const isRecord = (value: unknown): value is Record<PropertyKey, unknown> =>
  typeof value === "object" && value !== null;

function instrumentedDeepEqual(a: any, b: any): boolean {
  metrics.deepEqualCalls++;
  if (a === b) {
    metrics.deepEqualFastPathHits++;
    return true;
  }
  if (isRecord(a) && isRecord(b)) {
    if (a.constructor !== b.constructor) return false;
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!instrumentedDeepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return a !== a && b !== b; // NaN check
}

// ============================================================================
// Instrumented JSON.stringify wrapper
// ============================================================================

const originalStringify = JSON.stringify;
function instrumentedStringify(...args: Parameters<typeof JSON.stringify>) {
  metrics.jsonStringifyCalls++;
  return originalStringify.apply(JSON, args);
}

// ============================================================================
// Test Data Generators
// ============================================================================

function generateSmallDoc(id: string) {
  return {
    id,
    title: `Document ${id}`,
    content: "Lorem ipsum dolor sit amet ".repeat(20),
    meta: {
      author: "William",
      created: "2025-12-06",
      tags: ["test", "small"],
    },
  };
}

function generateMediumDoc(id: string) {
  return {
    id,
    type: "application/charm",
    data: {
      items: Array.from({ length: 100 }, (_, i) => ({
        id: `item-${i}`,
        name: `Item ${i}`,
        value: i * 10,
        nested: { a: 1, b: 2, c: 3 },
      })),
      config: {
        theme: "dark",
        language: "en",
        features: { a: true, b: false, c: true },
      },
      state: { selected: null, expanded: [], scroll: 0 },
    },
    meta: { author: "William", version: 42 },
  };
}

function generateLargeDoc(id: string) {
  return {
    id,
    records: Array.from({ length: 1000 }, (_, i) => ({
      id: `record-${i}`,
      data: { x: i, y: i * 2, label: `Record ${i}` },
    })),
    index: Object.fromEntries(
      Array.from({ length: 1000 }, (_, i) => [`key-${i}`, i])
    ),
  };
}

function measureTime<T>(fn: () => T): { result: T; timeMs: number } {
  const start = performance.now();
  const result = fn();
  return { result, timeMs: performance.now() - start };
}

function getMemoryUsage(): number {
  return Deno.memoryUsage().heapUsed;
}

// ============================================================================
// Baseline Tests
// ============================================================================

describe("Structural Sharing Baselines", () => {
  beforeEach(() => {
    resetMetrics();
  });

  afterAll(() => {
    console.log("\n========================================");
    console.log("  STRUCTURAL SHARING BASELINE SUMMARY");
    console.log("========================================\n");
    console.log("Save these metrics! Compare after implementing interning.\n");
  });

  describe("Scenario 1: Small Document (~1KB)", () => {
    const doc = generateSmallDoc("small-001");
    const docSize = JSON.stringify(doc).length;

    it(`measures document size (${docSize} bytes)`, () => {
      console.log(`\n  Small doc size: ${docSize} bytes`);
      expect(docSize).toBeGreaterThan(500);
      expect(docSize).toBeLessThan(2000);
    });

    it("measures deepEqual for identical structures", () => {
      resetMetrics();
      const doc1 = JSON.parse(JSON.stringify(doc));
      const doc2 = JSON.parse(JSON.stringify(doc));

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 1000; i++) {
          instrumentedDeepEqual(doc1, doc2);
        }
      });

      const fastPathRate = (metrics.deepEqualFastPathHits / metrics.deepEqualCalls) * 100;
      console.log(`  deepEqual (1000x identical small docs):`);
      console.log(`    - Total calls: ${metrics.deepEqualCalls}`);
      console.log(`    - Fast path hits: ${metrics.deepEqualFastPathHits} (${fastPathRate.toFixed(1)}%)`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);

      // Currently fast path should be ~0% (no interning)
      expect(metrics.deepEqualCalls).toBeGreaterThan(0);
    });

    it("measures deepEqual for one-field change", () => {
      resetMetrics();
      const doc1 = JSON.parse(JSON.stringify(doc));
      const doc2 = JSON.parse(JSON.stringify(doc));
      doc2.title = "Changed Title";

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 1000; i++) {
          instrumentedDeepEqual(doc1, doc2);
        }
      });

      console.log(`  deepEqual (1000x one-field diff):`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);
    });
  });

  describe("Scenario 2: Medium Document (~16KB)", () => {
    const doc = generateMediumDoc("medium-001");
    const docSize = JSON.stringify(doc).length;

    it(`measures document size (${docSize} bytes)`, () => {
      console.log(`\n  Medium doc size: ${docSize} bytes`);
      expect(docSize).toBeGreaterThan(5000);
      expect(docSize).toBeLessThan(30000);
    });

    it("measures deepEqual for identical structures", () => {
      resetMetrics();
      const doc1 = JSON.parse(JSON.stringify(doc));
      const doc2 = JSON.parse(JSON.stringify(doc));

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          instrumentedDeepEqual(doc1, doc2);
        }
      });

      const fastPathRate = (metrics.deepEqualFastPathHits / metrics.deepEqualCalls) * 100;
      console.log(`  deepEqual (100x identical medium docs):`);
      console.log(`    - Total calls: ${metrics.deepEqualCalls}`);
      console.log(`    - Fast path hits: ${metrics.deepEqualFastPathHits} (${fastPathRate.toFixed(1)}%)`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);
    });

    it("measures JSON.stringify for change detection pattern", () => {
      resetMetrics();
      const before = JSON.parse(JSON.stringify(doc));
      const after = JSON.parse(JSON.stringify(doc));

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          // This is the pattern from differential.ts
          if (before !== after) {
            instrumentedStringify(before);
            instrumentedStringify(after);
          }
        }
      });

      console.log(`  Change detection pattern (100x):`);
      console.log(`    - JSON.stringify calls: ${metrics.jsonStringifyCalls}`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);

      // With interning, before === after would be true, so 0 stringify calls
      expect(metrics.jsonStringifyCalls).toBe(200);
    });
  });

  describe("Scenario 3: Large Document (~100KB)", () => {
    const doc = generateLargeDoc("large-001");
    const docSize = JSON.stringify(doc).length;

    it(`measures document size (${docSize} bytes)`, () => {
      console.log(`\n  Large doc size: ${docSize} bytes`);
      expect(docSize).toBeGreaterThan(50000);
    });

    it("measures deepEqual for identical structures", () => {
      resetMetrics();
      const doc1 = JSON.parse(JSON.stringify(doc));
      const doc2 = JSON.parse(JSON.stringify(doc));

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 10; i++) {
          instrumentedDeepEqual(doc1, doc2);
        }
      });

      const fastPathRate = (metrics.deepEqualFastPathHits / metrics.deepEqualCalls) * 100;
      console.log(`  deepEqual (10x identical large docs):`);
      console.log(`    - Total calls: ${metrics.deepEqualCalls}`);
      console.log(`    - Fast path hits: ${metrics.deepEqualFastPathHits} (${fastPathRate.toFixed(1)}%)`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);
    });
  });

  describe("Scenario 4: Memory for Similar Documents", () => {
    it("measures memory for 100 documents with shared content", () => {
      // Force GC if available
      if (typeof Deno !== "undefined") {
        // @ts-ignore - gc may not be exposed
        globalThis.gc?.();
      }

      const beforeMem = getMemoryUsage();

      // Create 100 docs that share 80% structure (same config, different id/title)
      const sharedConfig = {
        theme: "dark",
        language: "en",
        features: { a: true, b: false, c: true },
        settings: Array.from({ length: 50 }, (_, i) => ({
          key: `setting-${i}`,
          value: `value-${i}`,
          metadata: { created: "2025-12-06", updated: "2025-12-06" },
        })),
      };

      const docs = Array.from({ length: 100 }, (_, i) => {
        // Without interning, each parse creates new objects
        const parsed = JSON.parse(JSON.stringify({
          id: `doc-${i}`,
          title: `Document ${i}`,
          config: sharedConfig,
        }));
        return parsed;
      });

      const afterMem = getMemoryUsage();
      const memUsed = afterMem - beforeMem;

      console.log(`\n  Memory for 100 similar docs:`);
      console.log(`    - Before: ${(beforeMem / 1024 / 1024).toFixed(2)} MB`);
      console.log(`    - After: ${(afterMem / 1024 / 1024).toFixed(2)} MB`);
      console.log(`    - Used: ${(memUsed / 1024 / 1024).toFixed(2)} MB`);

      // Keep docs alive to prevent GC
      expect(docs.length).toBe(100);
    });
  });

  describe("Scenario 5: Rapid Same-Value Updates", () => {
    it("measures overhead of checking unchanged values", () => {
      resetMetrics();
      const value = generateMediumDoc("unchanged");

      // Simulate checking if value changed 100 times
      let skipped = 0;
      let processed = 0;

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          const before = JSON.parse(JSON.stringify(value));
          const after = JSON.parse(JSON.stringify(value));

          // Current pattern without interning
          if (before !== after) {
            const beforeJson = instrumentedStringify(before);
            const afterJson = instrumentedStringify(after);
            if (beforeJson !== afterJson) {
              processed++;
            } else {
              skipped++;
            }
          } else {
            skipped++;
          }
        }
      });

      console.log(`\n  Rapid same-value updates (100x):`);
      console.log(`    - JSON.stringify calls: ${metrics.jsonStringifyCalls}`);
      console.log(`    - Skipped (unchanged): ${skipped}`);
      console.log(`    - Processed (false positive): ${processed}`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);

      // With interning: before === after, so 0 stringify calls
      expect(metrics.jsonStringifyCalls).toBe(200);
      expect(skipped).toBe(100);
    });
  });

  describe("Scenario 6: Subtree Comparison", () => {
    it("measures deepEqual on shared subtrees", () => {
      const sharedMeta = {
        author: "William",
        created: "2025-12-06",
        permissions: {
          read: ["user1", "user2", "user3"],
          write: ["user1"],
          admin: ["admin"],
        },
        history: Array.from({ length: 20 }, (_, i) => ({
          version: i,
          timestamp: `2025-12-0${(i % 9) + 1}`,
          changes: ["edit", "update", "save"],
        })),
      };

      resetMetrics();
      const doc1 = JSON.parse(JSON.stringify({ id: "doc1", meta: sharedMeta }));
      const doc2 = JSON.parse(JSON.stringify({ id: "doc2", meta: sharedMeta }));

      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 1000; i++) {
          // Compare just the meta subtrees
          instrumentedDeepEqual(doc1.meta, doc2.meta);
        }
      });

      const fastPathRate = (metrics.deepEqualFastPathHits / metrics.deepEqualCalls) * 100;
      console.log(`\n  Subtree comparison (1000x meta objects):`);
      console.log(`    - Total deepEqual calls: ${metrics.deepEqualCalls}`);
      console.log(`    - Fast path hits: ${metrics.deepEqualFastPathHits} (${fastPathRate.toFixed(1)}%)`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);

      // With interning: doc1.meta === doc2.meta, so 1 call with fast path per iteration
      // Currently: recursive comparison, many calls, 0% fast path at root
    });
  });
});
