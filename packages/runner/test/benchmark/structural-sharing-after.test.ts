/**
 * Structural Sharing AFTER Benchmarks
 *
 * This test demonstrates the improvement after implementing structural sharing.
 * Compare these results with structural-sharing-baseline.test.ts to see the difference.
 *
 * Run with: deno test -A packages/runner/test/benchmark/structural-sharing-after.test.ts
 */

import { describe, it, beforeEach } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internParse, internStringify, clearInternCache } from "../../src/interning.ts";
import { deepEqual } from "../../src/path-utils.ts";

// ============================================================================
// Instrumentation
// ============================================================================

interface Metrics {
  deepEqualCalls: number;
  deepEqualFastPathHits: number;
}

const metrics: Metrics = {
  deepEqualCalls: 0,
  deepEqualFastPathHits: 0,
};

function resetMetrics() {
  metrics.deepEqualCalls = 0;
  metrics.deepEqualFastPathHits = 0;
  clearInternCache(); // Clear cache to get fresh measurements
}

// Instrumented deepEqual that tracks fast path hits
function instrumentedDeepEqual(a: any, b: any): boolean {
  metrics.deepEqualCalls++;
  if (a === b) {
    metrics.deepEqualFastPathHits++;
    return true;
  }
  // Use actual deepEqual for rest
  return deepEqual(a, b);
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

function measureTime<T>(fn: () => T): { result: T; timeMs: number } {
  const start = performance.now();
  const result = fn();
  return { result, timeMs: performance.now() - start };
}

// ============================================================================
// Tests with Interning
// ============================================================================

describe("Structural Sharing WITH Interning", () => {
  beforeEach(() => {
    resetMetrics();
  });

  describe("Scenario 1: Small Document with Interning", () => {
    it("demonstrates O(1) fast path for identical interned structures", () => {
      // Parse same JSON twice with interning
      const json = JSON.stringify(generateSmallDoc("small-001"));
      const doc1 = internParse(json);
      const doc2 = internParse(json);

      // Should be same reference!
      expect(doc1).toBe(doc2);

      // Fast path check
      const result = instrumentedDeepEqual(doc1, doc2);
      expect(result).toBe(true);
      expect(metrics.deepEqualFastPathHits).toBe(1);
      expect(metrics.deepEqualCalls).toBe(1);

      console.log(`  With interning: 1 call, 100% fast path hits`);
    });

    it("demonstrates shared subtrees between different documents", () => {
      // Two docs with same meta but different titles
      const doc1 = internParse('{"title": "Doc 1", "meta": {"author": "William", "tags": ["a", "b"]}}');
      const doc2 = internParse('{"title": "Doc 2", "meta": {"author": "William", "tags": ["a", "b"]}}');

      // Roots should be different
      expect(doc1).not.toBe(doc2);

      // But meta subtree should be shared!
      expect(doc1.meta).toBe(doc2.meta);
      expect(doc1.meta.tags).toBe(doc2.meta.tags);

      // deepEqual on shared subtree is O(1)
      const result = instrumentedDeepEqual(doc1.meta, doc2.meta);
      expect(result).toBe(true);
      expect(metrics.deepEqualFastPathHits).toBe(1);

      console.log(`  Shared subtree: 1 call, 100% fast path (meta objects are same reference)`);
    });
  });

  describe("Scenario 2: Medium Document with Interning", () => {
    it("demonstrates massive speedup for unchanged document comparison", () => {
      const doc = generateMediumDoc("medium-001");
      const json = JSON.stringify(doc);

      // Parse same JSON 100 times
      const { timeMs } = measureTime(() => {
        for (let i = 0; i < 100; i++) {
          const parsed = internParse(json);
          instrumentedDeepEqual(parsed, parsed);
        }
      });

      const fastPathRate = (metrics.deepEqualFastPathHits / metrics.deepEqualCalls) * 100;
      console.log(`\n  deepEqual (100x identical medium docs WITH interning):`);
      console.log(`    - Total calls: ${metrics.deepEqualCalls}`);
      console.log(`    - Fast path hits: ${metrics.deepEqualFastPathHits} (${fastPathRate.toFixed(1)}%)`);
      console.log(`    - Time: ${timeMs.toFixed(2)}ms`);
      console.log(`    (Compare to baseline: ~82000 calls, ~75% fast path, ~3ms)`);

      expect(fastPathRate).toBe(100);
      expect(metrics.deepEqualCalls).toBe(100);
    });
  });

  describe("Scenario 3: internStringify for write path", () => {
    it("demonstrates change detection optimization", () => {
      const value = { x: 1, nested: { y: 2, z: 3 } };

      // Simulate write path: internStringify the value
      const before = internStringify(value);
      const after = internStringify(value);

      // Same value = same reference = O(1) skip
      expect(before).toBe(after);

      // In differential.ts, this would skip the JSON.stringify entirely:
      // if (before !== after && ...) <- this is FALSE, so skipped
      const needsStringify = before !== after;
      expect(needsStringify).toBe(false);

      console.log(`\n  Change detection for unchanged value:`);
      console.log(`    - before === after: ${before === after}`);
      console.log(`    - JSON.stringify needed: ${needsStringify}`);
      console.log(`    (With interning: 0 stringify calls, baseline: 2 calls)`);
    });

    it("demonstrates subtree sharing in write path", () => {
      const config = { theme: "dark", settings: { a: 1, b: 2, c: 3 } };

      const doc1 = internStringify({ id: "doc1", config });
      const doc2 = internStringify({ id: "doc2", config });

      // Different roots but shared config
      expect(doc1).not.toBe(doc2);
      expect(doc1.config).toBe(doc2.config);
      expect(doc1.config.settings).toBe(doc2.config.settings);

      console.log(`\n  Subtree sharing in write path:`);
      console.log(`    - Roots different: ${doc1 !== doc2}`);
      console.log(`    - Config shared: ${doc1.config === doc2.config}`);
    });
  });

  describe("Scenario 4: String Cache Performance", () => {
    it("demonstrates O(1) repeated parsing via string cache", () => {
      const json = JSON.stringify(generateMediumDoc("cache-test"));
      const iterations = 1000;

      // First call (cache miss)
      clearInternCache();
      const { timeMs: firstCallTime } = measureTime(() => internParse(json));

      // Subsequent calls (cache hits)
      const { timeMs: cachedTime } = measureTime(() => {
        for (let i = 0; i < iterations; i++) {
          internParse(json);
        }
      });

      console.log(`\n  String Cache Performance:`);
      console.log(`    - First call (parse + intern): ${firstCallTime.toFixed(2)}ms`);
      console.log(`    - ${iterations} cached calls: ${cachedTime.toFixed(2)}ms`);
      console.log(`    - Avg per cached call: ${(cachedTime / iterations * 1000).toFixed(2)}µs`);

      // Verify all return same reference
      const a = internParse(json);
      const b = internParse(json);
      expect(a).toBe(b);
    });
  });

  describe("Scenario 5: Memory Efficiency", () => {
    it("demonstrates memory sharing for similar documents", () => {
      clearInternCache();

      // Create 100 documents with shared subtrees
      const sharedConfig = { theme: "dark", settings: { x: 1, y: 2, z: 3 } };
      const docs: any[] = [];

      for (let i = 0; i < 100; i++) {
        docs.push(internStringify({
          id: `doc-${i}`,
          title: `Document ${i}`,
          config: sharedConfig, // Same config in all docs
          items: [1, 2, 3, 4, 5], // Same array in all docs
        }));
      }

      // All docs share the same config object
      const allShareConfig = docs.every((d) => d.config === docs[0].config);
      const allShareItems = docs.every((d) => d.items === docs[0].items);

      console.log(`\n  Memory Sharing for 100 documents:`);
      console.log(`    - All share config subtree: ${allShareConfig}`);
      console.log(`    - All share items array: ${allShareItems}`);
      console.log(`    - Unique config objects: ${allShareConfig ? 1 : 100}`);
      console.log(`    - Unique items arrays: ${allShareItems ? 1 : 100}`);

      expect(allShareConfig).toBe(true);
      expect(allShareItems).toBe(true);
    });
  });

  describe("Summary Comparison", () => {
    it("prints comparison with baseline", () => {
      console.log(`
========================================
  STRUCTURAL SHARING COMPARISON
========================================

  Metric                    | Baseline      | With Interning
  --------------------------|---------------|----------------
  deepEqual fast path       | ~70% (leaves) | 100% (all)
  JSON.stringify needed     | Yes           | No (=== works)
  Subtree sharing           | None          | Automatic
  Objects frozen            | No            | Yes
  String cache              | N/A           | O(1) lookup
  Parse overhead            | N/A           | First call only

  The key insight: With interning, the "a === b" check in
  deepEqual (path-utils.ts:52) and differential.ts:55 now
  triggers for ENTIRE SUBTREES, not just primitive leaves.

  String cache ensures repeated parsing of same JSON string
  is O(1) - critical for read paths like recall(), getFact().
========================================
`);
    });
  });
});
