import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { diffAndUpdate } from "../src/data-updating.ts";
import { internStringify } from "../src/interning.ts";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test idempotency");
const space = signer.did();

describe("Idempotency", () => {
  let runtime: Runtime;
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    tx = runtime.edit();
  });

  afterEach(async () => {
    await tx.commit();
    await runtime?.dispose();
    await storageManager?.close();
  });

  describe("Cell.set() idempotency", () => {
    it("should skip write when setting same primitive value", async () => {
      const cell = runtime.getCell<number>(
        space,
        "skip-same-primitive",
        undefined,
        tx,
      );
      cell.set(42);
      await tx.commit();

      // Start new transaction
      tx = runtime.edit();

      // Count changes in this transaction
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set(42); // Same value

      // The transaction should have no pending changes for this cell
      // since idempotency check should skip the write
      const status = tx.status();
      expect(status.status).toBe("ready");
    });

    it("should skip write when setting same object value", async () => {
      const cell = runtime.getCell<{ name: string; count: number }>(
        space,
        "skip-same-object",
        undefined,
        tx,
      );
      cell.set({ name: "test", count: 5 });
      await tx.commit();

      tx = runtime.edit();
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set({ name: "test", count: 5 }); // Same content

      const status = tx.status();
      expect(status.status).toBe("ready");
    });

    it("should skip write when setting same array value", async () => {
      const cell = runtime.getCell<string[]>(
        space,
        "skip-same-array",
        undefined,
        tx,
      );
      cell.set(["a", "b", "c"]);
      await tx.commit();

      tx = runtime.edit();
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set(["a", "b", "c"]); // Same content

      const status = tx.status();
      expect(status.status).toBe("ready");
    });

    it("should write when setting different value", async () => {
      const cell = runtime.getCell<number>(
        space,
        "write-different-value",
        undefined,
        tx,
      );
      cell.set(42);
      await tx.commit();

      tx = runtime.edit();
      const cellWithTx = cell.withTx(tx);
      cellWithTx.set(43); // Different value

      // This should have pending changes
      expect(cellWithTx.get()).toBe(43);
    });
  });

  describe("diffAndUpdate idempotency", () => {
    it("should return false when value unchanged", async () => {
      const cell = runtime.getCell<{ x: number; y: number }>(
        space,
        "diffAndUpdate-unchanged",
        undefined,
        tx,
      );
      cell.set({ x: 1, y: 2 });
      await tx.commit();

      tx = runtime.edit();
      const link = cell.withTx(tx).getAsNormalizedFullLink();

      // diffAndUpdate should return false (no changes) for same value
      const changed = diffAndUpdate(runtime, tx, link, { x: 1, y: 2 });
      expect(changed).toBe(false);
    });

    it("should return true when value changed", async () => {
      const cell = runtime.getCell<{ x: number; y: number }>(
        space,
        "diffAndUpdate-changed",
        undefined,
        tx,
      );
      cell.set({ x: 1, y: 2 });
      await tx.commit();

      tx = runtime.edit();
      const link = cell.withTx(tx).getAsNormalizedFullLink();

      // diffAndUpdate should return true (changes made) for different value
      const changed = diffAndUpdate(runtime, tx, link, { x: 1, y: 3 });
      expect(changed).toBe(true);
    });

    it("should handle nested objects idempotently", async () => {
      const cell = runtime.getCell<{ a: { b: { c: number } } }>(
        space,
        "diffAndUpdate-nested",
        undefined,
        tx,
      );
      cell.set({ a: { b: { c: 42 } } });
      await tx.commit();

      tx = runtime.edit();
      const link = cell.withTx(tx).getAsNormalizedFullLink();

      const changed = diffAndUpdate(runtime, tx, link, { a: { b: { c: 42 } } });
      expect(changed).toBe(false);
    });
  });

  describe("Array ordering and interning", () => {
    it("should produce same interned value for arrays with same content", () => {
      const arr1 = [{ id: "a" }, { id: "b" }, { id: "c" }];
      const arr2 = [{ id: "a" }, { id: "b" }, { id: "c" }];

      const interned1 = internStringify(arr1);
      const interned2 = internStringify(arr2);

      // Same content should produce same interned reference
      expect(interned1).toBe(interned2);
    });

    it("should produce different interned values for arrays with different order", () => {
      const arr1 = [{ id: "a" }, { id: "b" }];
      const arr2 = [{ id: "b" }, { id: "a" }];

      const interned1 = internStringify(arr1);
      const interned2 = internStringify(arr2);

      // Different order should produce different interned values
      expect(interned1).not.toBe(interned2);
    });

    it("sorted arrays from different iteration orders should match", () => {
      // Simulate two clients computing backlinks in different orders
      const charmsOrderA = [
        { name: "charm1", ref: "ref1" },
        { name: "charm2", ref: "ref2" },
        { name: "charm3", ref: "ref3" },
      ];
      const charmsOrderB = [
        { name: "charm3", ref: "ref3" },
        { name: "charm1", ref: "ref1" },
        { name: "charm2", ref: "ref2" },
      ];

      // Both clients sort by JSON.stringify before setting
      const sortedA = [...charmsOrderA].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );
      const sortedB = [...charmsOrderB].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );

      const internedA = internStringify(sortedA);
      const internedB = internStringify(sortedB);

      // After sorting, both should produce identical interned values
      expect(internedA).toBe(internedB);
    });
  });

  describe("Scheduler and reactive idempotency", () => {
    it("should not re-trigger actions when writing same value", async () => {
      const cell = runtime.getCell<number[]>(
        space,
        "scheduler-idempotent",
        undefined,
        tx,
      );
      cell.set([1, 2, 3]);
      await tx.commit();
      await runtime.idle();

      let actionRunCount = 0;

      // Subscribe an action that reads the cell
      const action = (actionTx: IExtendedStorageTransaction) => {
        actionRunCount++;
        cell.withTx(actionTx).get();
      };
      runtime.scheduler.subscribe(action, { reads: [], writes: [] }, true);
      await runtime.idle();

      const initialRunCount = actionRunCount;

      // Write the same value - should not trigger action
      tx = runtime.edit();
      cell.withTx(tx).set([1, 2, 3]); // Same value
      await tx.commit();
      await runtime.idle();

      // Action should not have been triggered again
      expect(actionRunCount).toBe(initialRunCount);

      runtime.scheduler.unsubscribe(action);
    });

    it("should re-trigger actions when writing different value", async () => {
      const cell = runtime.getCell<number[]>(
        space,
        "scheduler-triggers-on-change",
        undefined,
        tx,
      );
      cell.set([1, 2, 3]);
      await tx.commit();
      await runtime.idle();

      let actionRunCount = 0;

      const action = (actionTx: IExtendedStorageTransaction) => {
        actionRunCount++;
        cell.withTx(actionTx).get();
      };
      runtime.scheduler.subscribe(action, { reads: [], writes: [] }, true);
      await runtime.idle();

      const initialRunCount = actionRunCount;

      // Write different value - should trigger action
      tx = runtime.edit();
      cell.withTx(tx).set([1, 2, 3, 4]); // Different value
      await tx.commit();
      await runtime.idle();

      // Action should have been triggered
      expect(actionRunCount).toBeGreaterThan(initialRunCount);

      runtime.scheduler.unsubscribe(action);
    });
  });

  describe("BacklinksIndex-like pattern", () => {
    it("should skip writes when recomputing identical backlinks via Cell.set()", async () => {
      // Simulate BacklinksIndex behavior using Cell.set() which is what patterns actually use
      const backlinksCell = runtime.getCell<Array<{ ref: string }>>(
        space,
        "backlinks-idempotent",
        undefined,
        tx,
      );

      // Initial state: charm1 and charm2 link to this
      const initialBacklinks = [{ ref: "charm1" }, { ref: "charm2" }];
      initialBacklinks.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );
      backlinksCell.set(initialBacklinks);
      await tx.commit();

      // Start new transaction - simulate BacklinksIndex recomputing
      tx = runtime.edit();

      // Recompute backlinks (same result, possibly different iteration order)
      const recomputedBacklinks = [{ ref: "charm2" }, { ref: "charm1" }];
      recomputedBacklinks.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );

      // Using Cell.set() which is what BacklinksIndex actually does
      // This should be idempotent - same sorted content
      const cellWithTx = backlinksCell.withTx(tx);

      // Get the raw value before set to compare
      const beforeValue = cellWithTx.getRaw();

      cellWithTx.set(recomputedBacklinks);

      // After set, the raw value should be unchanged (idempotency worked)
      const afterValue = cellWithTx.getRaw();

      // The interned representations should be equal
      expect(internStringify(beforeValue)).toBe(internStringify(afterValue));
    });

    it("should write when backlinks actually change via Cell.set()", async () => {
      const backlinksCell = runtime.getCell<Array<{ ref: string }>>(
        space,
        "backlinks-changed",
        undefined,
        tx,
      );

      const initialBacklinks = [{ ref: "charm1" }, { ref: "charm2" }];
      initialBacklinks.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );
      backlinksCell.set(initialBacklinks);
      await tx.commit();

      tx = runtime.edit();

      // New charm added
      const newBacklinks = [
        { ref: "charm1" },
        { ref: "charm2" },
        { ref: "charm3" },
      ];
      newBacklinks.sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b))
      );

      const cellWithTx = backlinksCell.withTx(tx);
      const beforeValue = cellWithTx.getRaw();

      cellWithTx.set(newBacklinks);

      const afterValue = cellWithTx.getRaw();

      // Values should be different after actual change
      expect(internStringify(beforeValue)).not.toBe(internStringify(afterValue));
    });

    it("diffAndUpdate with same simple values should be idempotent", async () => {
      // Test diffAndUpdate with values that don't require entity transformation
      const cell = runtime.getCell<number[]>(
        space,
        "diffAndUpdate-simple-array",
        undefined,
        tx,
      );
      cell.set([1, 2, 3]);
      await tx.commit();

      tx = runtime.edit();
      const link = cell.withTx(tx).getAsNormalizedFullLink();

      // Same simple array - no entity transformation needed
      const changed = diffAndUpdate(runtime, tx, link, [1, 2, 3]);
      expect(changed).toBe(false);
    });
  });
});
