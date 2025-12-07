import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  clearInternCache,
  internParse,
  internStringify,
  isInterned,
} from "../src/interning.ts";

describe("Structural Sharing", () => {
  it("should deduplicate objects with same content", () => {
    const jsonA = '{"title": "Doc", "meta": {"author": "William"}}';
    const jsonB = '{"title": "Doc Updated", "meta": {"author": "William"}}';

    const rootA = internParse(jsonA);
    const rootB = internParse(jsonB);

    // Roots should be different
    expect(rootA).not.toBe(rootB);

    // Shared sub-tree should be same reference
    expect(rootA.meta).toBe(rootB.meta);
    expect(rootA.meta).toEqual({ author: "William" });
  });

  it("should deduplicate identical arrays", () => {
      const jsonA = '{"tags": ["a", "b"], "data": 1}';
      const jsonB = '{"tags": ["a", "b"], "data": 2}';
      
      const rootA = internParse(jsonA);
      const rootB = internParse(jsonB);
      
      expect(rootA.tags).toBe(rootB.tags);
  });

  it("should handle complex nested structures", () => {
    const obj = {
      id: 1,
      config: {
        enabled: true,
        roles: ["admin", "editor"],
      },
    };
    const str = JSON.stringify(obj);

    // Parse twice
    const a = internParse(str);
    const b = internParse(str);

    // Top level should be same because whole object is identical
    expect(a).toBe(b);

    // Nested properties should be same
    expect(a.config).toBe(b.config);
    expect(a.config.roles).toBe(b.config.roles);
  });
});

describe("Deep Freeze", () => {
  it("should freeze all returned objects", () => {
    const result = internParse('{"a": 1, "b": {"c": 2}}');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.b)).toBe(true);
  });

  it("should freeze arrays and their contents", () => {
    const result = internParse('{"items": [{"id": 1}, {"id": 2}]}');

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.items)).toBe(true);
    expect(Object.isFrozen(result.items[0])).toBe(true);
    expect(Object.isFrozen(result.items[1])).toBe(true);
  });

  it("should throw when attempting to mutate frozen object", () => {
    const result = internParse('{"x": 1}');

    expect(() => {
      "use strict";
      (result as any).x = 2;
    }).toThrow();
  });

  it("should throw when attempting to mutate nested frozen object", () => {
    const result = internParse('{"nested": {"x": 1}}');

    expect(() => {
      "use strict";
      (result.nested as any).x = 2;
    }).toThrow();
  });
});

describe("internStringify", () => {
  it("should return frozen, interned object", () => {
    const a = internStringify({ x: 1 });
    const b = internStringify({ x: 1 });

    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
  });

  it("should validate JSON serializability", () => {
    const circular: any = { a: 1 };
    circular.self = circular;

    expect(() => internStringify(circular)).toThrow();
  });

  it("should strip undefined values like JSON.stringify", () => {
    const result = internStringify({ a: 1, b: undefined });

    expect(result).toEqual({ a: 1 });
    expect("b" in result).toBe(false);
  });

  it("should share structure with internParse results", () => {
    const fromStringify = internStringify({ meta: { author: "William" } });
    const fromParse = internParse('{"meta": {"author": "William"}}');

    // The meta objects should be the same reference
    expect(fromStringify.meta).toBe(fromParse.meta);
  });
});

describe("isInterned", () => {
  it("should return true for interned objects", () => {
    const result = internParse('{"x": 1}');
    expect(isInterned(result)).toBe(true);
  });

  it("should return true for nested interned objects", () => {
    const result = internParse('{"nested": {"x": 1}}');
    expect(isInterned(result.nested)).toBe(true);
  });

  it("should return false for non-interned objects", () => {
    expect(isInterned({ x: 1 })).toBe(false);
    expect(isInterned(JSON.parse('{"x": 1}'))).toBe(false);
  });

  it("should return false for primitives", () => {
    expect(isInterned(null)).toBe(false);
    expect(isInterned(undefined)).toBe(false);
    expect(isInterned(42)).toBe(false);
    expect(isInterned("string")).toBe(false);
  });
});

describe("clearInternCache", () => {
  it("should clear the cache", () => {
    const a = internParse('{"unique": "value-for-clear-test"}');
    clearInternCache();
    const b = internParse('{"unique": "value-for-clear-test"}');

    // After clearing cache, should get different object references
    expect(a).not.toBe(b);
    // But they should still be equal
    expect(a).toEqual(b);
  });
});
