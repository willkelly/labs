import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  clearInternCache,
  internNode,
  internParse,
  internStringify,
  isInterned,
} from "../src/interning.ts";

describe("internNode", () => {
  afterEach(() => {
    clearInternCache();
  });

  it("should intern a basic object with empty children map", () => {
    const template = { name: "Alice", age: 30 };
    const internedChildren = new Map<string, unknown>();

    const result = internNode(template, internedChildren);

    // Should be frozen
    expect(Object.isFrozen(result)).toBe(true);

    // Should be interned
    expect(isInterned(result)).toBe(true);

    // Should preserve content
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("should intern an object with pre-interned children", () => {
    // First intern some child objects
    const child1 = internStringify({ value: "first" });
    const child2 = internStringify({ value: "second" });

    // Create template with placeholders
    const template = {
      name: "Parent",
      childA: null, // Will be replaced
      childB: null, // Will be replaced
      primitiveField: 42,
    };

    // Map of interned children
    const internedChildren = new Map<string, unknown>([
      ["childA", child1],
      ["childB", child2],
    ]);

    const result = internNode(template, internedChildren);

    // Should be frozen and interned
    expect(Object.isFrozen(result)).toBe(true);
    expect(isInterned(result)).toBe(true);

    // Should incorporate the interned children
    expect(result.childA).toBe(child1);
    expect(result.childB).toBe(child2);
    expect(result.primitiveField).toBe(42);
  });

  it("should intern an array with empty children map", () => {
    const template = [1, 2, 3, 4, 5];
    const internedChildren = new Map<string, unknown>();

    const result = internNode(template, internedChildren);

    // Should be frozen
    expect(Object.isFrozen(result)).toBe(true);

    // Should be interned
    expect(isInterned(result)).toBe(true);

    // Should preserve array content
    expect(result).toEqual([1, 2, 3, 4, 5]);
  });

  it("should intern an array with pre-interned children", () => {
    // First intern some child objects
    const child1 = internStringify({ id: 1, name: "First" });
    const child2 = internStringify({ id: 2, name: "Second" });
    const child3 = internStringify({ id: 3, name: "Third" });

    // Create template array
    const template = [null, null, null, "primitive"];

    // Map of interned children (by index as string)
    const internedChildren = new Map<string, unknown>([
      ["0", child1],
      ["1", child2],
      ["2", child3],
    ]);

    const result = internNode(template, internedChildren);

    // Should be frozen and interned
    expect(Object.isFrozen(result)).toBe(true);
    expect(isInterned(result)).toBe(true);

    // Should incorporate the interned children
    expect(result[0]).toBe(child1);
    expect(result[1]).toBe(child2);
    expect(result[2]).toBe(child3);
    expect(result[3]).toBe("primitive");
  });

  it("should provide structural sharing for identical content", () => {
    // Create two identical structures using internNode
    const template1 = { x: 10, y: 20 };
    const internedChildren1 = new Map<string, unknown>();
    const result1 = internNode(template1, internedChildren1);

    const template2 = { x: 10, y: 20 };
    const internedChildren2 = new Map<string, unknown>();
    const result2 = internNode(template2, internedChildren2);

    // Should return the exact same object reference
    expect(result1).toBe(result2);
  });

  it("should provide structural sharing with interned children", () => {
    // Intern a shared child
    const sharedChild = internStringify({ shared: "data" });

    // Create two parent objects with the same structure
    const template1 = { id: 1, child: null };
    const internedChildren1 = new Map<string, unknown>([["child", sharedChild]]);
    const result1 = internNode(template1, internedChildren1);

    const template2 = { id: 1, child: null };
    const internedChildren2 = new Map<string, unknown>([["child", sharedChild]]);
    const result2 = internNode(template2, internedChildren2);

    // Should return the exact same object reference
    expect(result1).toBe(result2);

    // Child should also be shared
    expect(result1.child).toBe(sharedChild);
    expect(result2.child).toBe(sharedChild);
  });

  it("should match internStringify result for equivalent content", () => {
    // Create a structure with internStringify
    const data = {
      name: "Test",
      values: [1, 2, 3],
      nested: {
        flag: true,
        items: ["a", "b", "c"],
      },
    };
    const viaStringify = internStringify(data);

    // Create the same structure bottom-up with internNode
    const items = internNode(["a", "b", "c"], new Map<string, unknown>());
    const nested = internNode(
      { flag: true, items: null },
      new Map<string, unknown>([["items", items]]),
    );
    const values = internNode([1, 2, 3], new Map<string, unknown>());
    const viaInternNode = internNode(
      { name: "Test", values: null, nested: null },
      new Map<string, unknown>([
        ["values", values],
        ["nested", nested],
      ]),
    );

    // Should return the exact same object reference
    expect(viaInternNode).toBe(viaStringify);
  });

  it("should handle nested object structures", () => {
    // Build bottom-up
    const leaf1 = internNode({ value: "leaf1" }, new Map());
    const leaf2 = internNode({ value: "leaf2" }, new Map());

    const branch = internNode(
      { left: null, right: null },
      new Map([
        ["left", leaf1],
        ["right", leaf2],
      ]),
    );

    const root = internNode(
      { type: "root", child: null },
      new Map([["child", branch]]),
    );

    // Verify structure
    expect(isInterned(root)).toBe(true);
    expect(Object.isFrozen(root)).toBe(true);
    expect(root.type).toBe("root");
    expect(root.child).toBe(branch);
    expect((root.child as any).left).toBe(leaf1);
    expect((root.child as any).right).toBe(leaf2);
  });

  it("should handle arrays of arrays", () => {
    // Build nested arrays bottom-up
    const innerArray1 = internNode([1, 2, 3], new Map());
    const innerArray2 = internNode([4, 5, 6], new Map());

    const outerArray = internNode(
      [null, null, "text"],
      new Map([
        ["0", innerArray1],
        ["1", innerArray2],
      ]),
    );

    expect(isInterned(outerArray)).toBe(true);
    expect(outerArray[0]).toBe(innerArray1);
    expect(outerArray[1]).toBe(innerArray2);
    expect(outerArray[2]).toBe("text");
  });

  it("should handle mixed object and array interning", () => {
    // Array of objects
    const obj1 = internNode({ id: 1 }, new Map());
    const obj2 = internNode({ id: 2 }, new Map());

    const array = internNode(
      [null, null],
      new Map([
        ["0", obj1],
        ["1", obj2],
      ]),
    );

    // Object containing array
    const wrapper = internNode(
      { items: null, count: 2 },
      new Map([["items", array]]),
    );

    expect(isInterned(wrapper)).toBe(true);
    expect(wrapper.items).toBe(array);
    expect((wrapper.items as any)[0]).toBe(obj1);
    expect((wrapper.items as any)[1]).toBe(obj2);
  });

  it("should not mutate the template object", () => {
    const template = { a: 1, b: 2 };
    const originalTemplate = { ...template };

    internNode(template, new Map());

    // Template should remain unchanged
    expect(template).toEqual(originalTemplate);
  });

  it("should handle empty objects and arrays", () => {
    const emptyObj = internNode({}, new Map());
    const emptyArr = internNode([], new Map());

    expect(isInterned(emptyObj)).toBe(true);
    expect(isInterned(emptyArr)).toBe(true);
    expect(Object.isFrozen(emptyObj)).toBe(true);
    expect(Object.isFrozen(emptyArr)).toBe(true);
  });

  it("should handle objects with null and undefined values", () => {
    const template = { a: null, b: undefined, c: "value" };
    const result = internNode(template, new Map());

    expect(isInterned(result)).toBe(true);
    expect(result.a).toBe(null);
    expect(result.b).toBe(undefined);
    expect(result.c).toBe("value");
  });
});

describe("internStringify and internParse", () => {
  afterEach(() => {
    clearInternCache();
  });

  it("should intern parsed JSON with structural sharing", () => {
    const json = JSON.stringify({ a: 1, b: { c: 2 } });
    const result1 = internParse(json);
    const result2 = internParse(json);

    // Same JSON string should return same object
    expect(result1).toBe(result2);
    expect(isInterned(result1)).toBe(true);
    expect(Object.isFrozen(result1)).toBe(true);
  });

  it("should intern stringified values with structural sharing", () => {
    const data = { x: 10, y: [1, 2, 3] };
    const result1 = internStringify(data);
    const result2 = internStringify(data);

    // Same structure should return same object
    expect(result1).toBe(result2);
    expect(isInterned(result1)).toBe(true);
    expect(Object.isFrozen(result1)).toBe(true);
  });

  it("should handle nested structures correctly", () => {
    const data = {
      users: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
      settings: {
        theme: "dark",
        notifications: true,
      },
    };

    const interned = internStringify(data);

    expect(isInterned(interned)).toBe(true);
    expect(Object.isFrozen(interned)).toBe(true);
    expect(interned.users.length).toBe(2);
    expect(interned.users[0].name).toBe("Alice");
    expect(interned.settings.theme).toBe("dark");
  });

  it("should share identical subtrees", () => {
    const data1 = {
      a: { shared: "structure", value: 123 },
      b: { shared: "structure", value: 123 },
    };

    const interned = internStringify(data1);

    // The identical subtrees should be the same object reference
    expect(interned.a).toBe(interned.b);
  });

  it("should handle arrays with duplicate objects", () => {
    const data = [
      { id: 1, name: "Item" },
      { id: 2, name: "Other" },
      { id: 1, name: "Item" }, // Duplicate of first
    ];

    const interned = internStringify(data);

    // First and third elements should share the same object
    expect(interned[0]).toBe(interned[2]);
    expect(interned[0]).not.toBe(interned[1]);
  });

  it("should handle primitives correctly", () => {
    expect(internStringify("string")).toBe("string");
    expect(internStringify(42)).toBe(42);
    expect(internStringify(true)).toBe(true);
    expect(internStringify(null)).toBe(null);
  });

  it("should round-trip correctly through stringify and parse", () => {
    const data = {
      number: 42,
      string: "test",
      boolean: true,
      null: null,
      array: [1, 2, 3],
      nested: {
        deep: {
          value: "nested",
        },
      },
    };

    const stringified = internStringify(data);
    const json = JSON.stringify(stringified);
    const parsed = internParse(json);

    // Should be structurally equal
    expect(parsed).toEqual(data);

    // Should be interned
    expect(isInterned(parsed)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("should handle large nested structures efficiently", () => {
    // Create a moderately deep structure
    const createNestedStructure = (depth: number): any => {
      if (depth === 0) {
        return { leaf: true, value: 42 };
      }
      return {
        level: depth,
        child: createNestedStructure(depth - 1),
        data: [1, 2, 3],
      };
    };

    const data = createNestedStructure(10);
    const interned1 = internStringify(data);
    const interned2 = internStringify(data);

    // Should return the same reference
    expect(interned1).toBe(interned2);
    expect(isInterned(interned1)).toBe(true);
  });

  it("should maintain cache independence between string and value caches", () => {
    const data = { test: "value" };
    const json1 = JSON.stringify(data);
    const json2 = JSON.stringify(data);

    // Parse from string (uses string cache)
    const parsed1 = internParse(json1);
    const parsed2 = internParse(json2);

    // Should be same due to string cache
    expect(parsed1).toBe(parsed2);

    // Stringify (uses value cache)
    const stringified = internStringify(data);

    // Should be same as parsed due to structural sharing
    expect(stringified).toBe(parsed1);
  });

  it("should handle objects with sorted keys correctly", () => {
    // Objects with different key order should still intern to same object
    const data1 = { z: 1, a: 2, m: 3 };
    const data2 = { a: 2, m: 3, z: 1 };

    const interned1 = internStringify(data1);
    const interned2 = internStringify(data2);

    // Should be the same object due to key sorting
    expect(interned1).toBe(interned2);
  });
});
