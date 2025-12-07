import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { internParse, isInterned } from "../src/interning.ts";

describe("internParse skipIntern parameter", () => {
  it("should skip interning when skipIntern=true", () => {
    const json = JSON.stringify({ data: "test", nested: { value: 123 } });
    const result = internParse(json, true);

    // Should not be interned when skipIntern=true
    expect(isInterned(result)).toBe(false);
    expect(Object.isFrozen(result)).toBe(false);

    // But should still parse correctly
    expect(result).toEqual({ data: "test", nested: { value: 123 } });
  });

  it("should intern normally when skipIntern=false or not provided", () => {
    const json = JSON.stringify({ data: "test", nested: { value: 123 } });

    // With skipIntern=false
    const result1 = internParse(json, false);
    expect(isInterned(result1)).toBe(true);
    expect(Object.isFrozen(result1)).toBe(true);

    // Without skipIntern parameter (defaults to false)
    const result2 = internParse(json);
    expect(isInterned(result2)).toBe(true);
    expect(Object.isFrozen(result2)).toBe(true);

    // Should be the same object due to structural sharing
    expect(result1).toBe(result2);
  });

  it("should not share structure between interned and non-interned values", () => {
    const json = JSON.stringify({ test: "value" });

    const interned = internParse(json, false);
    const nonInterned = internParse(json, true);

    // Should have same content
    expect(interned).toEqual(nonInterned);

    // But should be different objects
    expect(interned).not.toBe(nonInterned);

    // Interned should be frozen, non-interned should not
    expect(Object.isFrozen(interned)).toBe(true);
    expect(Object.isFrozen(nonInterned)).toBe(false);
  });

  it("should handle primitives correctly with skipIntern=true", () => {
    expect(internParse("42", true)).toBe(42);
    expect(internParse('"string"', true)).toBe("string");
    expect(internParse("true", true)).toBe(true);
    expect(internParse("null", true)).toBe(null);
  });

  it("should handle arrays correctly with skipIntern=true", () => {
    const json = JSON.stringify([1, 2, { nested: "value" }]);
    const result = internParse(json, true);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual([1, 2, { nested: "value" }]);
    expect(Object.isFrozen(result)).toBe(false);
    expect(isInterned(result)).toBe(false);
  });
});
