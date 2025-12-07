import { assertEquals, assertStrictEquals } from "@std/assert";
import { SubscriptionTrie } from "../src/subscription-trie.ts";
import { internStringify, clearInternCache } from "../src/interning.ts";
import { deepEqual } from "../src/path-utils.ts";

// =============================================================================
// Part 1: Validate deepEqual behavior
// =============================================================================

Deno.test("deepEqual - primitives", () => {
  assertEquals(deepEqual(1, 1), true, "same numbers");
  assertEquals(deepEqual(1, 2), false, "different numbers");
  assertEquals(deepEqual("a", "a"), true, "same strings");
  assertEquals(deepEqual("a", "b"), false, "different strings");
  assertEquals(deepEqual(null, null), true, "null === null");
  assertEquals(deepEqual(undefined, undefined), true, "undefined === undefined");
  assertEquals(deepEqual(null, undefined), false, "null !== undefined");
});

Deno.test("deepEqual - arrays", () => {
  assertEquals(deepEqual([], []), true, "empty arrays");
  assertEquals(deepEqual([1, 2], [1, 2]), true, "same arrays");
  assertEquals(deepEqual([1, 2], [1, 3]), false, "different arrays");
  assertEquals(deepEqual([1], [1, 2]), false, "different length arrays");
});

Deno.test("deepEqual - objects", () => {
  assertEquals(deepEqual({}, {}), true, "empty objects");
  assertEquals(deepEqual({ a: 1 }, { a: 1 }), true, "same objects");
  assertEquals(deepEqual({ a: 1 }, { a: 2 }), false, "different values");
  assertEquals(deepEqual({ a: 1 }, { b: 1 }), false, "different keys");
  assertEquals(deepEqual({ a: 1, b: 2 }, { b: 2, a: 1 }), true, "key order doesn't matter");
});

Deno.test("deepEqual - nested structures", () => {
  assertEquals(
    deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 2] } }),
    true,
    "same nested structure"
  );
  assertEquals(
    deepEqual({ a: { b: [1, 2] } }, { a: { b: [1, 3] } }),
    false,
    "different nested value"
  );
});

// =============================================================================
// Part 2: Validate === behavior with interning
// =============================================================================

Deno.test("interning - same structure gets same reference", () => {
  clearInternCache();

  const obj1 = internStringify({ a: 1, b: { c: 2 } });
  const obj2 = internStringify({ a: 1, b: { c: 2 } });

  assertStrictEquals(obj1, obj2, "same structure should be same reference");
  assertStrictEquals(obj1.b, obj2.b, "nested objects should also be same reference");
});

Deno.test("interning - different structures get different references", () => {
  clearInternCache();

  const obj1 = internStringify({ a: 1 });
  const obj2 = internStringify({ a: 2 });

  assertEquals(obj1 === obj2, false, "different structures should be different references");
});

Deno.test("interning - empty arrays are same reference", () => {
  clearInternCache();

  const obj1 = internStringify({ items: [] });
  const obj2 = internStringify({ items: [] });

  assertStrictEquals(obj1.items, obj2.items, "empty arrays should be same reference");
});

Deno.test("interning - arrays with same content are same reference", () => {
  clearInternCache();

  const obj1 = internStringify({ items: [1, 2, 3] });
  const obj2 = internStringify({ items: [1, 2, 3] });

  assertStrictEquals(obj1.items, obj2.items, "same arrays should be same reference");
});

Deno.test("interning - arrays with different content are different references", () => {
  clearInternCache();

  const obj1 = internStringify({ items: [1, 2, 3] });
  const obj2 = internStringify({ items: [1, 2, 4] });

  assertEquals(obj1.items === obj2.items, false, "different arrays should be different references");
});

// =============================================================================
// Part 3: The key test - interning SEPARATE before/after values
// =============================================================================

Deno.test("interning - before/after with unchanged nested value shares reference", () => {
  clearInternCache();

  // Simulate what happens in scheduler: we have before and after states
  const before = { value: { name: "test", items: [] } };
  const after = { value: { name: "test-updated", items: [] } };

  // If we intern them separately...
  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // The root objects should be different (name changed)
  assertEquals(internedBefore === internedAfter, false, "root should be different");
  assertEquals(internedBefore.value === internedAfter.value, false, "value should be different (name changed)");

  // BUT the items arrays should be the SAME reference (both are [])
  // This is the interning optimization
  assertStrictEquals(
    internedBefore.value.items,
    internedAfter.value.items,
    "unchanged nested items should be same reference"
  );
});

Deno.test("interning - before/after with changed nested value has different reference", () => {
  clearInternCache();

  const before = { value: { name: "test", items: ["a"] } };
  const after = { value: { name: "test", items: ["a", "b"] } };

  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // Root should be different because items changed
  assertEquals(internedBefore === internedAfter, false, "root should be different");
  assertEquals(internedBefore.value === internedAfter.value, false, "value should be different");
  assertEquals(
    internedBefore.value.items === internedAfter.value.items,
    false,
    "items should be different"
  );
});

// =============================================================================
// Part 4: SubscriptionTrie notification behavior
// =============================================================================

Deno.test("SubscriptionTrie - notifies on different references", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value"], () => notifications.push("value-listener"));

  const oldState = { value: { a: 1 } };
  const newState = { value: { a: 2 } };

  trie.notify(oldState, newState, (cb) => (cb as Function)());

  assertEquals(notifications, ["value-listener"], "should notify when values differ");
});

Deno.test("SubscriptionTrie - skips notification on same reference", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "items"], () => notifications.push("items-listener"));

  // Same reference - should skip
  const sharedItems = [1, 2, 3];
  const oldState = { value: { items: sharedItems } };
  const newState = { value: { items: sharedItems } };

  trie.notify(oldState, newState, (cb) => (cb as Function)());

  assertEquals(notifications, [], "should NOT notify when same reference");
});

Deno.test("SubscriptionTrie - with interned values, unchanged paths use same reference", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "items"], () => notifications.push("items-listener"));
  trie.subscribe(["value", "name"], () => notifications.push("name-listener"));

  const before = { value: { name: "old", items: [1, 2, 3] } };
  const after = { value: { name: "new", items: [1, 2, 3] } };

  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // Verify that items ARE the same reference after interning
  assertStrictEquals(
    internedBefore.value.items,
    internedAfter.value.items,
    "items should be same reference after interning"
  );

  trie.notify(internedBefore, internedAfter, (cb) => (cb as Function)());

  // name changed, so name-listener should fire
  // items didn't change (same ref), so items-listener should NOT fire
  assertEquals(notifications, ["name-listener"], "only name listener should fire");
});

Deno.test("SubscriptionTrie - with interned values, changed paths have different reference", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "items"], () => notifications.push("items-listener"));
  trie.subscribe(["value", "name"], () => notifications.push("name-listener"));

  const before = { value: { name: "old", items: [1, 2, 3] } };
  const after = { value: { name: "old", items: [1, 2, 3, 4] } }; // items changed

  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // Verify items are DIFFERENT after interning
  assertEquals(
    internedBefore.value.items === internedAfter.value.items,
    false,
    "items should be different reference after interning"
  );

  trie.notify(internedBefore, internedAfter, (cb) => (cb as Function)());

  // items changed, name didn't (but name is same so no notification)
  assertEquals(notifications, ["items-listener"], "only items listener should fire");
});

// =============================================================================
// Part 5: The problematic case - RAW values without interning
// =============================================================================

Deno.test("SubscriptionTrie - with RAW values, cannot skip unchanged subtrees", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "items"], () => notifications.push("items-listener"));
  trie.subscribe(["value", "name"], () => notifications.push("name-listener"));

  // RAW values - not interned
  const before = { value: { name: "old", items: [1, 2, 3] } };
  const after = { value: { name: "new", items: [1, 2, 3] } }; // only name changed

  // Without interning, items are DIFFERENT references even though content is same
  assertEquals(
    before.value.items === after.value.items,
    false,
    "raw items are different references"
  );

  trie.notify(before, after, (cb) => (cb as Function)());

  // With raw values, BOTH listeners fire because === fails for items
  // This is the cost of not interning - we lose the optimization
  assertEquals(
    notifications,
    ["name-listener", "items-listener"],
    "without interning, both listeners fire"
  );
});

// =============================================================================
// Part 6: Edge case - the pinnedCells problem
// =============================================================================

Deno.test("interning - pinnedCells scenario: both empty arrays are same reference", () => {
  clearInternCache();

  // This simulates what was happening in the llm-dialog test
  const before = { value: { pinnedCells: [] } };
  const after = { value: { pinnedCells: [] } }; // Same empty array

  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // After interning, these should be the SAME reference
  assertStrictEquals(
    internedBefore.value.pinnedCells,
    internedAfter.value.pinnedCells,
    "empty pinnedCells should be same reference"
  );

  // This means if we're listening to pinnedCells and both before/after have []
  // The notification should be SKIPPED (which is correct!)
});

Deno.test("interning - pinnedCells scenario: empty to non-empty are different", () => {
  clearInternCache();

  const before = { value: { pinnedCells: [] } };
  const after = { value: { pinnedCells: ["cell-123"] } };

  const internedBefore = internStringify(before);
  const internedAfter = internStringify(after);

  // These should be DIFFERENT references
  assertEquals(
    internedBefore.value.pinnedCells === internedAfter.value.pinnedCells,
    false,
    "pinnedCells should be different when content differs"
  );
});

// =============================================================================
// Part 7: Root notification vs path notification
// =============================================================================

Deno.test("SubscriptionTrie - root subscription gets notified on any change", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  // Subscribe at root (empty path)
  trie.subscribe([], () => notifications.push("root-listener"));

  const before = { value: { a: 1 } };
  const after = { value: { a: 2 } };

  trie.notify(before, after, (cb) => (cb as Function)());

  assertEquals(notifications, ["root-listener"], "root listener should fire");
});

Deno.test("SubscriptionTrie - notifyAtPath notifies ancestors", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe([], () => notifications.push("root"));
  trie.subscribe(["value"], () => notifications.push("value"));
  trie.subscribe(["value", "nested"], () => notifications.push("nested"));

  const before = { value: { nested: { deep: 1 } } };
  const after = { value: { nested: { deep: 2 } } };

  // Notify at a specific path
  trie.notifyAtPath(["value", "nested"], before, after, (cb) => (cb as Function)());

  // Should notify: root, value, and nested (all ancestors plus the target)
  assertEquals(
    notifications,
    ["root", "value", "nested"],
    "should notify all ancestors and target"
  );
});

Deno.test("SubscriptionTrie - notifyAtPath with empty path calls notify", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe([], () => notifications.push("root"));
  trie.subscribe(["value"], () => notifications.push("value"));

  const before = { value: 1 };
  const after = { value: 2 };

  trie.notifyAtPath([], before, after, (cb) => (cb as Function)());

  // Empty path should delegate to notify()
  assertEquals(notifications, ["root", "value"], "should notify both root and value");
});

// =============================================================================
// Part 8: Simulate scheduler behavior - sequence of updates
// =============================================================================

Deno.test("scheduler simulation - sequence of updates with interning", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "pinnedCells"], () => notifications.push("pinnedCells"));
  trie.subscribe(["value", "messages"], () => notifications.push("messages"));

  // Simulate initial state (empty) - explicit type to avoid never[] inference
  type State = { value: { pinnedCells: string[]; messages: string[] } };
  let currentState: State = internStringify({ value: { pinnedCells: [] as string[], messages: [] as string[] } });

  // Update 1: Add a message
  const update1 = internStringify({ value: { pinnedCells: [], messages: ["hello"] } });
  trie.notify(currentState, update1, (cb) => (cb as Function)());
  assertEquals(notifications, ["messages"], "update 1: only messages changed");
  currentState = update1;
  notifications.length = 0;

  // Update 2: Pin a cell
  const update2 = internStringify({ value: { pinnedCells: ["cell-1"], messages: ["hello"] } });
  trie.notify(currentState, update2, (cb) => (cb as Function)());
  assertEquals(notifications, ["pinnedCells"], "update 2: only pinnedCells changed");
  currentState = update2;
  notifications.length = 0;

  // Update 3: Add another message (pinnedCells unchanged)
  const update3 = internStringify({
    value: { pinnedCells: ["cell-1"], messages: ["hello", "world"] },
  });
  trie.notify(currentState, update3, (cb) => (cb as Function)());
  assertEquals(notifications, ["messages"], "update 3: only messages changed, pinnedCells same ref");
  notifications.length = 0;
});

Deno.test("scheduler simulation - WITHOUT interning gets extra notifications", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value", "pinnedCells"], () => notifications.push("pinnedCells"));
  trie.subscribe(["value", "messages"], () => notifications.push("messages"));

  // Same sequence but WITHOUT interning - explicit type
  type State = { value: { pinnedCells: string[]; messages: string[] } };
  let currentState: State = { value: { pinnedCells: [], messages: [] } };

  // Update 1: Add a message (but pinnedCells is same content [])
  const update1 = { value: { pinnedCells: [], messages: ["hello"] } };
  trie.notify(currentState, update1, (cb) => (cb as Function)());
  // Without interning, BOTH fire because [] !== [] (different refs)
  assertEquals(
    notifications,
    ["pinnedCells", "messages"],
    "without interning: both fire due to different refs"
  );
  currentState = update1;
  notifications.length = 0;

  // Update 2: Pin a cell
  const update2 = { value: { pinnedCells: ["cell-1"], messages: ["hello"] } };
  trie.notify(currentState, update2, (cb) => (cb as Function)());
  assertEquals(
    notifications,
    ["pinnedCells", "messages"],
    "without interning: both fire again"
  );
});

// =============================================================================
// Part 9: The ACTUAL problematic case - maintaining interned state across calls
// =============================================================================

Deno.test("interning - maintaining state between updates preserves references", () => {
  clearInternCache();

  // This is what the scheduler SHOULD do:
  // Keep the interned state and compare against new interned state

  let internedState = internStringify({ value: { a: 1, b: { nested: [1, 2, 3] } } });

  // Simulate an update that only changes 'a'
  const newRaw = { value: { a: 2, b: { nested: [1, 2, 3] } } };
  const newInterned = internStringify(newRaw);

  // The unchanged 'b.nested' should be the same reference
  assertStrictEquals(
    internedState.value.b.nested,
    newInterned.value.b.nested,
    "unchanged nested array should be same ref"
  );
  assertStrictEquals(
    internedState.value.b,
    newInterned.value.b,
    "unchanged nested object should be same ref"
  );
  assertEquals(
    internedState.value.a === newInterned.value.a,
    false,
    "changed values should differ"
  );
});

Deno.test("interning - key insight: freshly interning before AND after works", () => {
  clearInternCache();

  // The question: if we receive raw before/after from storage and intern both,
  // do we get correct reference sharing?

  const rawBefore = { value: { shared: { data: "same" }, changing: 1 } };
  const rawAfter = { value: { shared: { data: "same" }, changing: 2 } };

  const internedBefore = internStringify(rawBefore);
  const internedAfter = internStringify(rawAfter);

  // YES - interning finds the same canonical form for shared structures
  assertStrictEquals(
    internedBefore.value.shared,
    internedAfter.value.shared,
    "freshly interning both should still share identical sub-structures"
  );
});

// =============================================================================
// Part 10: Exact llm-dialog scenario - pinnedCells from [] to [{...}]
// =============================================================================

Deno.test("llm-dialog scenario - pinnedCells change from [] to [cell]", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  // Subscribe to pinnedCells like llm-dialog does
  trie.subscribe(["value", "pinnedCells"], () => notifications.push("pinnedCells"));
  trie.subscribe(["value", "messages"], () => notifications.push("messages"));

  // Initial state: empty pinnedCells and messages
  const initial = internStringify({
    value: {
      pinnedCells: [] as Array<{ path: string; name: string }>,
      messages: [] as Array<{ role: string; content: string }>,
    },
  });

  // After pinning: one cell in pinnedCells
  const afterPin = internStringify({
    value: {
      pinnedCells: [{ path: "/of:test123", name: "Test Cell" }],
      messages: [{ role: "user", content: "pin this" }],
    },
  });

  // Debug: verify these are DIFFERENT references
  console.log("initial.value.pinnedCells:", initial.value.pinnedCells);
  console.log("afterPin.value.pinnedCells:", afterPin.value.pinnedCells);
  console.log("Same ref?", initial.value.pinnedCells === afterPin.value.pinnedCells);

  trie.notify(initial, afterPin, (cb) => (cb as Function)());

  // Both should fire because both changed
  assertEquals(
    notifications.sort(),
    ["messages", "pinnedCells"].sort(),
    "both pinnedCells and messages should fire when they change"
  );
});

Deno.test("llm-dialog scenario - verify empty array interning doesn't break detection", () => {
  clearInternCache();

  // This tests whether empty arrays being shared causes issues
  const state1 = internStringify({
    value: { pinnedCells: [], other: "a" },
  });

  const state2 = internStringify({
    value: { pinnedCells: [], other: "b" },
  });

  // Empty arrays should be same ref
  assertStrictEquals(
    state1.value.pinnedCells,
    state2.value.pinnedCells,
    "empty arrays should be same ref"
  );

  // But the "value" objects should differ (different "other" field)
  assertEquals(
    state1.value === state2.value,
    false,
    "value objects should differ when any field changes"
  );

  // Now test with populated pinnedCells
  const state3 = internStringify({
    value: { pinnedCells: [{ path: "p", name: "n" }], other: "b" },
  });

  assertEquals(
    state2.value.pinnedCells === state3.value.pinnedCells,
    false,
    "populated array should differ from empty"
  );
});

// =============================================================================
// Part 11: Test multi-entity scenario like llm-dialog
// =============================================================================

Deno.test("multi-entity: action subscribed to entity A should trigger when A changes", () => {
  clearInternCache();
  const trieA = new SubscriptionTrie();
  const trieB = new SubscriptionTrie();

  const aNotifications: string[] = [];
  const bNotifications: string[] = [];

  // Action A subscribes to ["value"] in trie A
  trieA.subscribe(["value"], () => aNotifications.push("A triggered"));
  // Action B subscribes to ["value", "pinnedCells"] in trie B
  trieB.subscribe(["value", "pinnedCells"], () => bNotifications.push("B triggered"));

  // Initial state for both entities
  const initialA = internStringify({ value: { pinnedCells: [] as any[], messages: [] } });
  const initialB = internStringify({ value: { pinnedCells: [], output: "initial" } });

  // Update A's pinnedCells
  const updatedA = internStringify({ value: { pinnedCells: [{ path: "p", name: "n" }], messages: [] } });

  // Notify trie A about the change
  trieA.notify(initialA, updatedA, (cb) => (cb as Function)());

  // Action A should have been triggered
  assertEquals(aNotifications, ["A triggered"], "Action A should trigger when A changes");
  assertEquals(bNotifications, [], "Action B should NOT trigger (different entity)");
});

// =============================================================================
// Part 12: Metrics - compare with/without interning
// =============================================================================

Deno.test("metrics - with interning, fewer subtrees visited", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  trie.resetMetrics();

  // Subscribe to several nested paths
  trie.subscribe(["value", "a"], () => {});
  trie.subscribe(["value", "b"], () => {});
  trie.subscribe(["value", "c", "nested"], () => {});
  trie.subscribe(["value", "d", "deep", "value"], () => {});

  // Create before/after with only "a" changed, rest identical
  const before = internStringify({
    value: {
      a: "changed-from",
      b: { data: [1, 2, 3, 4, 5] },
      c: { nested: { items: Array(100).fill("item") } },
      d: { deep: { value: { lots: "of", nested: "data" } } },
    },
  });

  const after = internStringify({
    value: {
      a: "changed-to",  // Only this changed
      b: { data: [1, 2, 3, 4, 5] },  // Same
      c: { nested: { items: Array(100).fill("item") } },  // Same
      d: { deep: { value: { lots: "of", nested: "data" } } },  // Same
    },
  });

  // Verify interning worked - unchanged subtrees are same reference
  assertStrictEquals(before.value.b, after.value.b, "b should be same ref");
  assertStrictEquals(before.value.c, after.value.c, "c should be same ref");
  assertStrictEquals(before.value.d, after.value.d, "d should be same ref");

  trie.notify(before, after, () => {});

  console.log("With interning:", trie.metrics);

  // With interning, we should skip the unchanged subtrees
  assertEquals(trie.metrics.subtreesSkipped >= 3, true,
    `Expected >= 3 subtrees skipped (b, c, d), got ${trie.metrics.subtreesSkipped}`);
  assertEquals(trie.metrics.actionsTriggered, 1,
    `Expected 1 action triggered (a listener), got ${trie.metrics.actionsTriggered}`);
});

Deno.test("metrics - without interning, all subtrees visited", () => {
  const trie = new SubscriptionTrie();
  trie.resetMetrics();

  // Subscribe to several nested paths
  trie.subscribe(["value", "a"], () => {});
  trie.subscribe(["value", "b"], () => {});
  trie.subscribe(["value", "c", "nested"], () => {});
  trie.subscribe(["value", "d", "deep", "value"], () => {});

  // RAW values - not interned, so identical content has different references
  const before = {
    value: {
      a: "changed-from",
      b: { data: [1, 2, 3, 4, 5] },
      c: { nested: { items: Array(100).fill("item") } },
      d: { deep: { value: { lots: "of", nested: "data" } } },
    },
  };

  const after = {
    value: {
      a: "changed-to",  // Changed
      b: { data: [1, 2, 3, 4, 5] },  // Same content, DIFFERENT reference
      c: { nested: { items: Array(100).fill("item") } },  // Same content, DIFFERENT reference
      d: { deep: { value: { lots: "of", nested: "data" } } },  // Same content, DIFFERENT reference
    },
  };

  // Verify these are NOT the same reference
  assertEquals(before.value.b === after.value.b, false, "b should be different refs without interning");

  trie.notify(before, after, () => {});

  console.log("Without interning:", trie.metrics);

  // Without interning, ALL subscribed paths trigger because objects have different refs
  // The key metric: 4 actions triggered vs 1 with interning (4x more work!)
  assertEquals(trie.metrics.actionsTriggered, 4,
    `Expected 4 actions triggered (all listeners), got ${trie.metrics.actionsTriggered}`);
  // More nodes visited without interning optimization
  assertEquals(trie.metrics.nodesVisited > 3, true,
    `Expected more nodes visited than with interning (3), got ${trie.metrics.nodesVisited}`);
});

Deno.test("metrics - efficiency ratio comparison", () => {
  clearInternCache();

  // Simulate a complex state with many properties
  const createComplexState = (changedField: string) => ({
    value: {
      config: { theme: "dark", lang: "en", notifications: true },
      users: Array(10).fill({ name: "user", email: "test@test.com" }),
      messages: Array(20).fill({ id: 1, text: "hello", ts: 123 }),
      settings: { audio: true, video: false, quality: "high" },
      changedField,  // This is the only thing that changes
    },
  });

  // With interning
  const trieInterned = new SubscriptionTrie();
  trieInterned.subscribe(["value", "config"], () => {});
  trieInterned.subscribe(["value", "users"], () => {});
  trieInterned.subscribe(["value", "messages"], () => {});
  trieInterned.subscribe(["value", "settings"], () => {});
  trieInterned.subscribe(["value", "changedField"], () => {});

  const beforeInterned = internStringify(createComplexState("before"));
  const afterInterned = internStringify(createComplexState("after"));

  trieInterned.notify(beforeInterned, afterInterned, () => {});

  // Without interning
  const trieRaw = new SubscriptionTrie();
  trieRaw.subscribe(["value", "config"], () => {});
  trieRaw.subscribe(["value", "users"], () => {});
  trieRaw.subscribe(["value", "messages"], () => {});
  trieRaw.subscribe(["value", "settings"], () => {});
  trieRaw.subscribe(["value", "changedField"], () => {});

  const beforeRaw = createComplexState("before");
  const afterRaw = createComplexState("after");

  trieRaw.notify(beforeRaw, afterRaw, () => {});

  console.log("\nEfficiency comparison:");
  console.log("  Interned:", trieInterned.metrics);
  console.log("  Raw:     ", trieRaw.metrics);
  console.log(`  Actions triggered: ${trieInterned.metrics.actionsTriggered} vs ${trieRaw.metrics.actionsTriggered}`);
  console.log(`  Nodes visited: ${trieInterned.metrics.nodesVisited} vs ${trieRaw.metrics.nodesVisited}`);

  // KEY METRIC: Interned should trigger far fewer actions
  assertEquals(
    trieInterned.metrics.actionsTriggered < trieRaw.metrics.actionsTriggered,
    true,
    `Interning should trigger fewer actions: ${trieInterned.metrics.actionsTriggered} < ${trieRaw.metrics.actionsTriggered}`
  );

  // Interned should visit fewer nodes
  assertEquals(
    trieInterned.metrics.nodesVisited < trieRaw.metrics.nodesVisited,
    true,
    `Interning should visit fewer nodes: ${trieInterned.metrics.nodesVisited} < ${trieRaw.metrics.nodesVisited}`
  );

  // The reduction ratio should be significant (at least 2x fewer actions)
  const actionReduction = trieRaw.metrics.actionsTriggered / trieInterned.metrics.actionsTriggered;
  console.log(`  Action reduction ratio: ${actionReduction.toFixed(1)}x fewer actions with interning`);
  assertEquals(actionReduction >= 2, true,
    `Expected at least 2x reduction in actions, got ${actionReduction.toFixed(1)}x`);
});

Deno.test("chain reaction: change in entity A triggers action that reads A and writes B", () => {
  clearInternCache();
  const trieA = new SubscriptionTrie();
  const trieB = new SubscriptionTrie();

  const triggered: string[] = [];
  let entityAState = internStringify({ value: { pinnedCells: [] as any[] } });
  let entityBState = internStringify({ value: { outputPinnedCells: [] as any[] } });

  // Action that reads from A and writes to B
  const chainAction = () => {
    triggered.push("chain action");
    // Simulate: read A's pinnedCells, write to B's outputPinnedCells
    const aPinnedCells = entityAState.value.pinnedCells;
    // In real code, this would write to storage and cause another notification
  };

  trieA.subscribe(["value", "pinnedCells"], chainAction);

  // Subscriber on B to verify it would get updated
  trieB.subscribe(["value", "outputPinnedCells"], () => triggered.push("B subscriber"));

  // Update A's pinnedCells (simulating handlePin)
  const newAState = internStringify({ value: { pinnedCells: [{ path: "/of:test", name: "Test" }] } });

  // The pinnedCells arrays should be different references
  assertEquals(
    entityAState.value.pinnedCells === newAState.value.pinnedCells,
    false,
    "pinnedCells should be different (empty vs populated)"
  );

  trieA.notify(entityAState, newAState, (cb) => (cb as Function)());

  // Chain action should have been triggered
  assertEquals(triggered, ["chain action"], "chain action should trigger");
  entityAState = newAState;

  // Now simulate B being updated (which would happen in the chain action)
  const newBState = internStringify({ value: { outputPinnedCells: [{ path: "/of:test", name: "Test" }] } });
  trieB.notify(entityBState, newBState, (cb) => (cb as Function)());

  assertEquals(triggered, ["chain action", "B subscriber"], "B subscriber should also trigger");
});

// =============================================================================
// Part 12: Entity creation/deletion (undefined before/after)
// =============================================================================

Deno.test("SubscriptionTrie - entity creation (undefined before)", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value"], () => notifications.push("value-listener"));
  trie.subscribe(["value", "name"], () => notifications.push("name-listener"));

  // Entity creation: before is undefined, after has data
  const before = undefined;
  const after = internStringify({ value: { name: "new entity" } });

  trie.notify(before, after, (cb) => (cb as Function)());

  // Both listeners should fire - the entity was created
  assertEquals(
    notifications.sort(),
    ["name-listener", "value-listener"].sort(),
    "all listeners should fire on entity creation"
  );
});

Deno.test("SubscriptionTrie - entity deletion (undefined after)", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value"], () => notifications.push("value-listener"));
  trie.subscribe(["value", "items"], () => notifications.push("items-listener"));

  // Entity deletion: before has data, after is undefined
  const before = internStringify({ value: { items: [1, 2, 3] } });
  const after = undefined;

  trie.notify(before, after, (cb) => (cb as Function)());

  // Both listeners should fire - the entity was deleted
  assertEquals(
    notifications.sort(),
    ["items-listener", "value-listener"].sort(),
    "all listeners should fire on entity deletion"
  );
});

Deno.test("SubscriptionTrie - both undefined (no-op)", () => {
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value"], () => notifications.push("value-listener"));

  // Both undefined - nothing should happen
  trie.notify(undefined, undefined, (cb) => (cb as Function)());

  assertEquals(notifications, [], "no notifications when both are undefined");
});

Deno.test("SubscriptionTrie - notifyAtPath with undefined before (creation)", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe([], () => notifications.push("root"));
  trie.subscribe(["value"], () => notifications.push("value"));
  trie.subscribe(["value", "data"], () => notifications.push("data"));

  const before = undefined;
  const after = internStringify({ value: { data: "created" } });

  trie.notifyAtPath(["value", "data"], before, after, (cb) => (cb as Function)());

  // Should notify ancestors and target
  assertEquals(
    notifications.sort(),
    ["data", "root", "value"].sort(),
    "should notify all ancestors and target on creation"
  );
});

Deno.test("scheduler simulation - entity lifecycle with interning", () => {
  clearInternCache();
  const trie = new SubscriptionTrie();
  const notifications: string[] = [];

  trie.subscribe(["value"], () => notifications.push("value"));
  trie.subscribe(["value", "status"], () => notifications.push("status"));

  // 1. Entity creation (undefined -> data)
  let currentState: any = undefined;
  const created = internStringify({ value: { status: "active", data: [] } });

  trie.notify(currentState, created, (cb) => (cb as Function)());
  assertEquals(notifications.sort(), ["status", "value"].sort(), "creation triggers listeners");
  currentState = created;
  notifications.length = 0;

  // 2. Entity update (data -> different data)
  const updated = internStringify({ value: { status: "paused", data: [] } });
  trie.notify(currentState, updated, (cb) => (cb as Function)());
  // value listener fires because value object changed (contains changed status)
  // status listener fires because status changed
  assertEquals(notifications.sort(), ["status", "value"].sort(), "update triggers value and status (data unchanged)");
  currentState = updated;
  notifications.length = 0;

  // 3. Entity deletion (data -> undefined)
  trie.notify(currentState, undefined, (cb) => (cb as Function)());
  assertEquals(notifications.sort(), ["status", "value"].sort(), "deletion triggers listeners");
});
