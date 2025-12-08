import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assertSpyCall, assertSpyCalls, spy } from "@std/testing/mock";
import { type IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { Runtime } from "../src/runtime.ts";
import {
  type Action,
  type EventHandler,
  ignoreReadForScheduling,
} from "../src/scheduler.ts";
import { Identity } from "@commontools/identity";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import type { Entity } from "@commontools/memory/interface";
import * as Fact from "@commontools/memory/fact";
import * as Changes from "@commontools/memory/changes";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

describe("scheduler", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
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

  it("should run actions when cells change", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should run actions when cells change 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions when cells change 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions when cells change 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);
    a.withTx(tx).send(2); // Simulate external change
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("schedule shouldn't run immediately", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should schedule shouldn't run immediately 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    }, true);
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2); // No log, simulate external change
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should remove actions", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "should remove actions 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should remove actions 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should remove actions 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(3);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);

    runtime.scheduler.unsubscribe(adder);
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(2);
    expect(c.get()).toBe(4);
  });

  it("scheduler should return a cancel function", async () => {
    let runCount = 0;
    const a = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "scheduler should return a cancel function 3",
      undefined,
      tx,
    );
    c.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder: Action = (tx) => {
      runCount++;
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const cancel = runtime.scheduler.subscribe(adder, {
      reads: [
        a.getAsNormalizedFullLink(),
        b.getAsNormalizedFullLink(),
      ],
      writes: [c.getAsNormalizedFullLink()],
    }, true);
    expect(runCount).toBe(0);
    expect(c.get()).toBe(0);
    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
    cancel();
    a.withTx(tx).send(3);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runCount).toBe(1);
    expect(c.get()).toBe(4);
  });

  it("should run actions in topological order", async () => {
    const runs: string[] = [];
    const a = runtime.getCell<number>(
      space,
      "should run actions in topological order 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should run actions in topological order 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should run actions in topological order 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should run actions in topological order 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should run actions in topological order 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      runs.push("adder1");
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      runs.push("adder2");
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, true);
    await runtime.idle();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(4);

    d.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2");
    expect(c.get()).toBe(3);
    expect(e.get()).toBe(5);

    a.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(runs.join(",")).toBe("adder1,adder2,adder2,adder1,adder2");
    expect(c.get()).toBe(4);
    expect(e.get()).toBe(6);
  });

  it("should stop eventually when encountering infinite loops", async () => {
    let maxRuns = 120; // More than the limit in scheduler
    const a = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 1",
      undefined,
      tx,
    );
    a.set(1);
    const b = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 2",
      undefined,
      tx,
    );
    b.set(2);
    const c = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 3",
      undefined,
      tx,
    );
    c.set(0);
    const d = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 4",
      undefined,
      tx,
    );
    d.set(1);
    const e = runtime.getCell<number>(
      space,
      "should stop eventually when encountering infinite loops 5",
      undefined,
      tx,
    );
    e.set(0);
    tx.commit();
    tx = runtime.edit();
    const adder1: Action = (tx) => {
      c.withTx(tx).send(
        a.withTx(tx).get() + b.withTx(tx).get(),
      );
    };
    const adder2: Action = (tx) => {
      e.withTx(tx).send(
        c.withTx(tx).get() + d.withTx(tx).get(),
      );
    };
    const adder3: Action = (tx) => {
      if (--maxRuns <= 0) return;
      c.withTx(tx).send(
        e.withTx(tx).get() + b.withTx(tx).get(),
      );
    };

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(adder1, { reads: [], writes: [] }, true);
    await runtime.idle();
    runtime.scheduler.subscribe(adder2, { reads: [], writes: [] }, true);
    await runtime.idle();
    runtime.scheduler.subscribe(adder3, { reads: [], writes: [] }, true);
    await runtime.idle();

    await runtime.idle();

    expect(maxRuns).toBeGreaterThan(10);
    assertSpyCall(stopped, 0, undefined);
  });

  it("should not loop on r/w changes on its own output", async () => {
    const counter = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 1",
      undefined,
      tx,
    );
    counter.set(0);
    const by = runtime.getCell<number>(
      space,
      "should not loop on r/w changes on its own output 2",
      undefined,
      tx,
    );
    by.set(1);
    tx.commit();
    tx = runtime.edit();
    const inc: Action = (tx) =>
      counter
        .withTx(tx)
        .send(counter.withTx(tx).get() + by.withTx(tx).get());

    const stopper = {
      stop: () => {},
    };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(counter.get()).toBe(1);
    await runtime.idle();
    expect(counter.get()).toBe(1);

    by.withTx(tx).send(2);
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();
    expect(counter.get()).toBe(3);

    assertSpyCalls(stopped, 0);
  });

  it("should immediately run actions that have no dependencies", async () => {
    let runs = 0;
    const inc: Action = () => runs++;
    runtime.scheduler.subscribe(inc, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(runs).toBe(1);
  });

  it("should not create dependencies when using getRaw with ignoreReadForScheduling", async () => {
    // Create a source cell that will be read with ignored metadata
    const sourceCell = runtime.getCell<{ value: number }>(
      space,
      "source-cell-for-ignore-test",
      undefined,
      tx,
    );
    sourceCell.set({ value: 1 });

    // Create a result cell to track action runs (avoiding self-dependencies)
    const resultCell = runtime.getCell<{ count: number; lastValue: any }>(
      space,
      "result-cell-for-ignore-test",
      undefined,
      tx,
    );
    resultCell.set({ count: 0, lastValue: null });
    tx.commit();
    tx = runtime.edit();

    let actionRunCount = 0;
    let lastReadValue: any;

    // Action that ONLY uses ignored reads
    const ignoredReadAction: Action = (actionTx) => {
      actionRunCount++;

      // Read with ignoreReadForScheduling - should NOT create dependency
      lastReadValue = sourceCell.withTx(actionTx).getRaw({
        meta: ignoreReadForScheduling,
      });

      // Write to result cell to track that the action ran
      resultCell.withTx(actionTx).set({
        count: actionRunCount,
        lastValue: lastReadValue,
      });
    };

    // Run the action initially
    runtime.scheduler.subscribe(
      ignoredReadAction,
      { reads: [], writes: [] },
      true,
    );
    await runtime.idle();
    expect(actionRunCount).toBe(1);
    expect(lastReadValue).toEqual({ value: 1 });
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });

    // Change the source cell
    sourceCell.withTx(tx).set({ value: 5 });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Action should NOT run again because the read was ignored
    expect(actionRunCount).toBe(1); // Still 1!
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } }); // Unchanged

    // Change the source cell again to be extra sure
    sourceCell.withTx(tx).set({ value: 10 });
    tx.commit();
    tx = runtime.edit();
    await runtime.idle();

    // Still should not have run
    expect(actionRunCount).toBe(1);
    expect(resultCell.get()).toEqual({ count: 1, lastValue: { value: 1 } });
  });
});

describe("event handling", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    // Create runtime with the shared storage provider
    // We need to bypass the URL-based configuration for this test
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

  it("should queue and process events", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should queue and process events 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should queue and process events 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);

    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventCell.get()).toBe(0); // Events are _not_ written to cell
    expect(eventResultCell.get()).toBe(2);
  });

  it("should remove event handlers", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should remove event handlers 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventCell.withTx(tx).send(event);
    };

    const removeHandler = runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);

    removeHandler();

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventCell.get()).toBe(1);
  });

  it("should handle events with nested paths", async () => {
    const parentCell = runtime.getCell<{ child: { value: number } }>(
      space,
      "should handle events with nested paths 1",
      undefined,
      tx,
    );
    parentCell.set({ child: { value: 0 } });
    tx.commit();

    let eventCount = 0;

    const eventHandler: EventHandler = () => {
      eventCount++;
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      parentCell.key("child").key("value").getAsNormalizedFullLink(),
      42,
    );
    await runtime.idle();

    expect(eventCount).toBe(1);
  });

  it("should process events in order", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should process events in order 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    tx.commit();

    const events: number[] = [];

    const eventHandler: EventHandler = (_tx, event) => {
      events.push(event);
    };

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 3);

    await runtime.idle();

    expect(events).toEqual([1, 2, 3]);
  });

  it("should trigger recomputation of dependent cells", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 1",
      undefined,
      tx,
    );
    eventCell.set(0);
    const eventResultCell = runtime.getCell<number>(
      space,
      "should trigger recomputation of dependent cells 2",
      undefined,
      tx,
    );
    eventResultCell.set(0);
    tx.commit();

    let eventCount = 0;
    let actionCount = 0;
    let lastEventSeen = 0;

    const eventHandler: EventHandler = (tx, event) => {
      eventCount++;
      eventResultCell.withTx(tx).send(event);
    };

    const action = (tx: IExtendedStorageTransaction) => {
      actionCount++;
      lastEventSeen = eventResultCell.withTx(tx).get();
    };
    runtime.scheduler.subscribe(action, { reads: [], writes: [] }, true);
    await runtime.idle();

    runtime.scheduler.addEventHandler(
      eventHandler,
      eventCell.getAsNormalizedFullLink(),
    );

    expect(actionCount).toBe(1);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 1);
    await runtime.idle();

    expect(eventCount).toBe(1);
    expect(eventResultCell.get()).toBe(1);

    expect(actionCount).toBe(2);

    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 2);
    await runtime.idle();

    expect(eventCount).toBe(2);
    expect(eventResultCell.get()).toBe(2);
    expect(actionCount).toBe(3);
    expect(lastEventSeen).toBe(2);
  });

  it(
    "should retry event handler when commit fails, up to retries count",
    async () => {
      // Prepare remote memory with existing fact to induce conflict on commit
      const memory = storageManager.session().mount(space);
      const entityId = `test:retry-conflict-${Date.now()}` as Entity;
      const existingFact = Fact.assert({
        the: "application/json",
        of: entityId,
        is: { version: 1 },
      });
      await memory.transact({ changes: Changes.from([existingFact]) });

      // Reset local replica so local writes will conflict with remote state
      const { replica } = storageManager.open(space);
      (replica as any).reset();

      // Set up an event cell and commit initial state
      const eventCell = runtime.getCell<number>(
        space,
        "should retry event handler on conflict",
        undefined,
        tx,
      );
      eventCell.set(0);
      await tx.commit();

      // Event handler that writes a conflicting value to the same entity
      let attempts = 0;
      const handler: EventHandler = (tx, _event) => {
        attempts++;
        // Force commit failure for the first 5 attempts to exercise retries.
        if (attempts <= 5) {
          tx.abort("force-abort-for-retry");
          return;
        }
        // On the final attempt, perform a regular write.
        tx.write({
          space,
          id: entityId,
          type: "application/json",
          path: [],
        }, { version: 2 });
      };

      runtime.scheduler.addEventHandler(
        handler,
        eventCell.getAsNormalizedFullLink(),
      );

      // Queue event (uses default retries configured in scheduler)
      runtime.scheduler.queueEvent(
        eventCell.getAsNormalizedFullLink(),
        1,
      );

      // First idle may return before the commit callback schedules retries.
      await runtime.idle();
      // Wait for any re-queued events to process.
      await runtime.idle();

      // Should attempt initial + default retries times (DEFAULT_RETRIES=5)
      expect(attempts).toBe(6);

      // No further assertions needed; this verifies retry behavior only.
    },
  );
});

describe("async cycle detection", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should detect cycles that span async commit boundaries", async () => {
    // This test demonstrates the cycle detection bug:
    // When an action's commit happens async, the loopCounter resets between
    // execute() cycles, allowing infinite loops to go undetected.
    //
    // The fix should ensure that cycle detection works even when notifications
    // arrive after the scheduler has gone "idle".

    const counter = runtime.getCell<number>(
      space,
      "async-cycle-counter",
      undefined,
      tx,
    );
    counter.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const maxRunsBeforeGivingUp = 150; // More than MAX_ITERATIONS_PER_RUN (100)

    const stopper = { stop: () => {} };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    // This action reads and writes to the same cell, creating a self-loop.
    // Each run increments the counter, which triggers a notification,
    // which should trigger the action again.
    const selfLoopAction: Action = (actionTx) => {
      runCount++;
      const current = counter.withTx(actionTx).get();

      // Safety valve: stop after maxRunsBeforeGivingUp to prevent test hanging
      if (runCount >= maxRunsBeforeGivingUp) {
        return;
      }

      // Write a new value - this SHOULD trigger cycle detection
      counter.withTx(actionTx).set(current + 1);
    };

    // Subscribe with empty deps initially, will learn deps from first run
    runtime.scheduler.subscribe(
      selfLoopAction,
      { reads: [], writes: [] },
      true,
    );

    // Wait for the reactive system to stabilize (or hit limits)
    // We need multiple idle() calls because each async commit creates a new cycle
    for (let i = 0; i < 20; i++) {
      await runtime.idle();
      // Give async commits time to fire notifications
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    // The cycle detection SHOULD have triggered an error before hitting
    // maxRunsBeforeGivingUp. If runCount >= MAX_ITERATIONS_PER_RUN and
    // the error handler was NOT called, then cycle detection failed.
    console.log(`[async-cycle-test] runCount: ${runCount}`);

    // This is the assertion that will FAIL with the current bug:
    // We expect the error handler to be called (cycle detected)
    // Currently, it won't be called because loopCounter resets between cycles
    if (runCount >= 100) {
      // If we ran 100+ times, cycle detection should have kicked in
      assertSpyCalls(stopped, 1);
    } else {
      // If we ran fewer times, either:
      // 1. The interning prevented re-triggering (value didn't "change")
      // 2. Or cycle detection worked and stopped us early
      // Either way, we should not have run excessively
      expect(runCount).toBeLessThan(100);
    }
  });

  it("should detect excessive re-runs when reading a changing list (chatbot scenario)", async () => {
    // This simulates the chatbot issue:
    // 1. A "charm list" cell exists with some charms
    // 2. A new "chatbot" action is added that reads the charm list
    // 3. When the chatbot runs, it might cause indirect changes
    //    (e.g., via backlinks index recalculation)
    // 4. This could trigger excessive re-runs

    const charmList = runtime.getCell<string[]>(
      space,
      "charm-list-for-chatbot-test",
      undefined,
      tx,
    );
    charmList.set(["charm1", "charm2", "charm3"]);

    // This simulates a derived/computed cell that depends on charmList
    // (like BacklinksIndex depends on allCharms)
    const derivedData = runtime.getCell<{ count: number; timestamp: number }>(
      space,
      "derived-data-for-chatbot-test",
      undefined,
      tx,
    );
    derivedData.set({ count: 0, timestamp: 0 });

    await tx.commit();
    tx = runtime.edit();

    let chatbotRunCount = 0;
    let derivedRunCount = 0;
    const maxRuns = 150;

    const stopper = { stop: () => {} };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError((err) => {
      console.log(`[chatbot-test] Error: ${err.message}`);
      stopper.stop();
    });

    // "Derived" action: reads charmList, writes derivedData with a new timestamp
    // This simulates how BacklinksIndex recalculates when allCharms changes
    const derivedAction: Action = (actionTx) => {
      derivedRunCount++;
      if (derivedRunCount >= maxRuns) return;

      const list = charmList.withTx(actionTx).get();
      // Write derived data with current timestamp - THIS ALWAYS CHANGES
      derivedData.withTx(actionTx).set({
        count: list.length,
        timestamp: Date.now(), // This makes every write unique!
      });
    };

    // "Chatbot" action: reads charmList AND derivedData
    // When either changes, it should re-run
    const chatbotAction: Action = (actionTx) => {
      chatbotRunCount++;
      if (chatbotRunCount >= maxRuns) return;

      // Read both the list and derived data
      const list = charmList.withTx(actionTx).get();
      const derived = derivedData.withTx(actionTx).get();

      // Log what we see
      if (chatbotRunCount <= 5 || chatbotRunCount % 20 === 0) {
        console.log(
          `[chatbot-test] run ${chatbotRunCount}: list.length=${list.length}, derived.count=${derived.count}`,
        );
      }
    };

    // Subscribe derivedAction first
    runtime.scheduler.subscribe(derivedAction, { reads: [], writes: [] }, true);
    await runtime.idle();

    // Now subscribe chatbotAction
    runtime.scheduler.subscribe(chatbotAction, { reads: [], writes: [] }, true);

    // Wait for the system to stabilize (or hit limits)
    for (let i = 0; i < 30; i++) {
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    console.log(
      `[chatbot-test] Final: chatbot=${chatbotRunCount}, derived=${derivedRunCount}`,
    );

    // The derived action writes a new timestamp each time, which should
    // trigger the chatbot. But cycle detection should stop this.
    //
    // If cycle detection is working properly, we should see an error
    // OR the runs should be capped at a reasonable number.
    //
    // If cycle detection is broken, we'll hit maxRuns (150) without error.

    if (chatbotRunCount >= 100 || derivedRunCount >= 100) {
      // Should have triggered cycle detection
      assertSpyCalls(stopped, 1);
    } else {
      // System stabilized before hitting limit
      expect(chatbotRunCount + derivedRunCount).toBeLessThan(100);
    }
  });

  it("should detect cycles in multi-action chains across async boundaries", async () => {
    // More complex scenario: A -> B -> A chain where each step commits async
    const cellA = runtime.getCell<number>(
      space,
      "async-chain-a",
      undefined,
      tx,
    );
    cellA.set(0);

    const cellB = runtime.getCell<number>(
      space,
      "async-chain-b",
      undefined,
      tx,
    );
    cellB.set(0);

    await tx.commit();
    tx = runtime.edit();

    let actionACount = 0;
    let actionBCount = 0;
    const maxRuns = 150;

    const stopper = { stop: () => {} };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError(() => stopper.stop());

    // Action A: reads cellB, writes cellA
    const actionA: Action = (actionTx) => {
      actionACount++;
      if (actionACount >= maxRuns) return;
      const bVal = cellB.withTx(actionTx).get();
      cellA.withTx(actionTx).set(bVal + 1);
    };

    // Action B: reads cellA, writes cellB
    const actionB: Action = (actionTx) => {
      actionBCount++;
      if (actionBCount >= maxRuns) return;
      const aVal = cellA.withTx(actionTx).get();
      cellB.withTx(actionTx).set(aVal + 1);
    };

    runtime.scheduler.subscribe(actionA, { reads: [], writes: [] }, true);
    await runtime.idle();

    runtime.scheduler.subscribe(actionB, { reads: [], writes: [] }, true);

    // Let the async chain run
    for (let i = 0; i < 30; i++) {
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const totalRuns = actionACount + actionBCount;
    console.log(
      `[async-chain-test] actionA: ${actionACount}, actionB: ${actionBCount}, total: ${totalRuns}`,
    );

    // With proper cycle detection, the total should be capped at ~100
    // and an error should be raised
    if (totalRuns >= 100) {
      assertSpyCalls(stopped, 1);
    } else {
      expect(totalRuns).toBeLessThan(100);
    }
  });

  it("DEMONSTRATES ISSUE: N actions in cycle allows N*100 iterations", async () => {
    // With N actions in a cycle, each can run 100 times before being stopped.
    // Total iterations = N * 100.
    // For real charms with many lift() functions, this can be thousands.

    const NUM_ACTIONS = 10; // Simulate 10 lift functions in a cycle

    // Create cells for the chain: action[i] reads cell[i-1], writes cell[i]
    const cells: ReturnType<typeof runtime.getCell>[] = [];
    for (let i = 0; i < NUM_ACTIONS; i++) {
      const cell = runtime.getCell<number>(
        space,
        `chain-cell-${i}`,
        undefined,
        tx,
      );
      cell.set(0);
      cells.push(cell);
    }
    await tx.commit();
    tx = runtime.edit();

    const runCounts: number[] = new Array(NUM_ACTIONS).fill(0);
    let totalRuns = 0;
    const maxRunsPerAction = 150;

    const stopper = { stop: () => {} };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError((err) => {
      console.log(`[chain-test] Error: ${err.message}`);
      stopper.stop();
    });

    // Create N actions in a cycle: 0 reads N-1, writes 0; 1 reads 0, writes 1; etc.
    const actions: Action[] = [];
    for (let i = 0; i < NUM_ACTIONS; i++) {
      const prevIdx = (i - 1 + NUM_ACTIONS) % NUM_ACTIONS;
      const action: Action = (actionTx) => {
        runCounts[i]++;
        totalRuns++;
        if (runCounts[i] >= maxRunsPerAction) return;

        const prev = cells[prevIdx].withTx(actionTx).get() as number;
        cells[i].withTx(actionTx).set(prev + 1);
      };
      actions.push(action);
    }

    // Subscribe all actions
    for (const action of actions) {
      runtime.scheduler.subscribe(action, { reads: [], writes: [] }, true);
    }

    // Let the cycle run
    for (let i = 0; i < 50; i++) {
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    console.log(`[chain-test] Run counts: ${runCounts.join(", ")}`);
    console.log(`[chain-test] Total runs: ${totalRuns}`);
    console.log(`[chain-test] Expected max (N * 100): ${NUM_ACTIONS * 100}`);

    // With N=10 actions, total could be up to 10 * 100 = 1000 before all stopped
    // This demonstrates the multiplier effect
    expect(totalRuns).toBeGreaterThan(100); // More than single-action limit
  });

  it("DEMONSTRATES BUG: loopCounter resets when scheduler goes idle between async commits", async () => {
    // This test demonstrates the cycle detection bug:
    // If there's only ONE action that triggers itself, and notifications
    // arrive AFTER the scheduler goes idle, the loopCounter resets and
    // cycle detection never triggers.

    const counter = runtime.getCell<number>(
      space,
      "solo-loop-counter",
      undefined,
      tx,
    );
    counter.set(0);
    await tx.commit();
    tx = runtime.edit();

    let runCount = 0;
    const maxRuns = 500; // Way more than MAX_ITERATIONS_PER_RUN (100)

    const stopper = { stop: () => {} };
    const stopped = spy(stopper, "stop");
    runtime.scheduler.onError((err) => {
      console.log(`[solo-loop-test] Error triggered: ${err.message}`);
      stopper.stop();
    });

    // Single action that reads and writes to same cell
    // Unlike ping-pong, this is a self-loop
    const selfLoop: Action = (actionTx) => {
      runCount++;
      const current = counter.withTx(actionTx).get();

      if (runCount <= 5 || runCount % 50 === 0) {
        console.log(`[solo-loop-test] run ${runCount}, counter=${current}`);
      }

      if (runCount >= maxRuns) {
        console.log(`[solo-loop-test] Safety valve hit at ${runCount}`);
        return;
      }

      // Write incremented value - this creates a NEW value each time
      counter.withTx(actionTx).set(current + 1);
    };

    runtime.scheduler.subscribe(selfLoop, { reads: [], writes: [] }, true);

    // Run many idle cycles to give the loop time to execute
    for (let i = 0; i < 100; i++) {
      await runtime.idle();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    console.log(`[solo-loop-test] Final runCount: ${runCount}`);

    // BUG DEMONSTRATION:
    // If cycle detection worked across async boundaries, runCount should be ~100
    // and stopped should be called.
    //
    // But if loopCounter resets between execute() cycles (because pending goes
    // empty while waiting for async commit), runCount could exceed 100 without
    // triggering cycle detection.

    if (runCount > 100 && stopped.calls.length === 0) {
      console.log(
        `[solo-loop-test] BUG CONFIRMED: ${runCount} runs without cycle detection!`,
      );
      // This demonstrates the bug - we ran more than 100 times without error
      expect(runCount).toBeGreaterThan(100);
    } else if (runCount <= 100) {
      // If system stabilized, that's OK (interning prevented re-triggers)
      console.log(`[solo-loop-test] System stabilized at ${runCount} runs`);
    } else {
      // Cycle detection worked
      assertSpyCalls(stopped, 1);
    }
  });
});

describe("interning and notifications", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should NOT trigger notifications when writing same array content", async () => {
    // Test if Merkle interning prevents notifications when array content is same
    const arrayCell = runtime.getCell<string[]>(
      space,
      "interning-array-test",
      undefined,
      tx,
    );
    arrayCell.set(["a", "b", "c"]);
    await tx.commit();
    tx = runtime.edit();

    let readerRunCount = 0;

    // Reader action subscribes to the array
    const reader: Action = (actionTx) => {
      readerRunCount++;
      arrayCell.withTx(actionTx).get();
      console.log(`[interning-test] reader run ${readerRunCount}`);
    };

    // Writer action writes a NEW array with SAME content
    let writerRunCount = 0;
    const writer: Action = (actionTx) => {
      writerRunCount++;
      if (writerRunCount > 10) return; // Safety limit

      // Write a NEW array with same content - should this trigger reader?
      arrayCell.withTx(actionTx).set(["a", "b", "c"]);
      console.log(`[interning-test] writer run ${writerRunCount}`);
    };

    runtime.scheduler.subscribe(reader, { reads: [], writes: [] }, true);
    await runtime.idle();
    expect(readerRunCount).toBe(1);

    runtime.scheduler.subscribe(writer, { reads: [], writes: [] }, true);
    await runtime.idle();

    console.log(
      `[interning-test] Final: reader=${readerRunCount}, writer=${writerRunCount}`,
    );

    // If interning works, reader should only run once (initial)
    // because writer's writes are same content = same reference
    // If interning doesn't catch this, reader runs multiple times
    expect(readerRunCount).toBe(1); // This might fail if interning doesn't work!
  });

  it("internStringify should return same reference for identical nested objects", async () => {
    // First verify internStringify directly - is the interning working?
    const { internStringify, clearInternCache } = await import("../src/interning.ts");

    clearInternCache(); // Start fresh

    const obj1 = { name: "charm1", data: { value: 1 } };
    const obj2 = { name: "charm1", data: { value: 1 } };

    const interned1 = internStringify(obj1);
    const interned2 = internStringify(obj2);

    console.log(`[intern-direct] obj1 === obj2: ${obj1 === obj2}`);
    console.log(`[intern-direct] interned1 === interned2: ${interned1 === interned2}`);

    // This SHOULD pass if interning works correctly
    expect(interned1).toBe(interned2);
  });

  it("should NOT trigger notifications when writing same complex objects", async () => {
    // Test with charm-like objects that have nested structure
    type CharmLike = { name: string; data: { value: number } };

    const charmList = runtime.getCell<CharmLike[]>(
      space,
      "interning-complex-test",
      undefined,
      tx,
    );

    // Get entity info for debugging
    const entityLink = charmList.getAsNormalizedFullLink();
    console.log(`[complex-interning] Entity: ${JSON.stringify(entityLink)}`);

    charmList.set([
      { name: "charm1", data: { value: 1 } },
      { name: "charm2", data: { value: 2 } },
    ]);
    await tx.commit();
    tx = runtime.edit();

    // Check what's stored
    const stored1 = charmList.getRaw();
    console.log(`[complex-interning] After first commit: ${JSON.stringify(stored1)}`);

    let readerRunCount = 0;
    const reader: Action = (actionTx) => {
      readerRunCount++;
      const val = charmList.withTx(actionTx).get();
      console.log(`[complex-interning] Reader run ${readerRunCount}, value: ${JSON.stringify(val)}`);
    };

    let writerRunCount = 0;
    const writer: Action = (actionTx) => {
      writerRunCount++;
      if (writerRunCount > 10) return;

      // Write NEW objects with SAME content
      charmList.withTx(actionTx).set([
        { name: "charm1", data: { value: 1 } },
        { name: "charm2", data: { value: 2 } },
      ]);
      console.log(`[complex-interning] Writer run ${writerRunCount}`);
    };

    runtime.scheduler.subscribe(reader, { reads: [], writes: [] }, true);
    await runtime.idle();

    runtime.scheduler.subscribe(writer, { reads: [], writes: [] }, true);
    await runtime.idle();

    // Check what's stored after writer
    const stored2 = charmList.getRaw();
    console.log(`[complex-interning] After writer: ${JSON.stringify(stored2)}`);
    console.log(`[complex-interning] stored1 === stored2: ${stored1 === stored2}`);

    console.log(
      `[complex-interning] Final: reader=${readerRunCount}, writer=${writerRunCount}`,
    );

    expect(readerRunCount).toBe(1);
  });

  it("DEMONSTRATES ISSUE: cell references in arrays bypass interning", async () => {
    // This tests what happens with cell references - like charm.backlinks which is a Cell
    const backlinksCell = runtime.getCell<string[]>(
      space,
      "backlinks-cell-ref",
      undefined,
      tx,
    );
    backlinksCell.set([]);

    // A charm-like object that contains a cell reference
    type CharmWithCell = { name: string; backlinks: typeof backlinksCell };

    const charmList = runtime.getCell<any[]>(
      space,
      "interning-cell-ref-test",
      undefined,
      tx,
    );

    // Store charm with cell reference - does this even serialize correctly?
    await tx.commit();
    tx = runtime.edit();

    let readerRunCount = 0;
    const reader: Action = (actionTx) => {
      readerRunCount++;
      charmList.withTx(actionTx).get();
    };

    // Writer that updates backlinks (like BacklinksIndex does)
    let writerRunCount = 0;
    const writer: Action = (actionTx) => {
      writerRunCount++;
      if (writerRunCount > 5) return;

      // This simulates BacklinksIndex writing to charm.backlinks
      backlinksCell.withTx(actionTx).set(["link1"]);
    };

    runtime.scheduler.subscribe(reader, { reads: [], writes: [] }, true);
    await runtime.idle();

    runtime.scheduler.subscribe(writer, { reads: [], writes: [] }, true);
    await runtime.idle();
    await runtime.idle();

    console.log(
      `[cell-ref] Final: reader=${readerRunCount}, writer=${writerRunCount}`,
    );

    // The reader shouldn't re-run just because backlinksCell changed
    // (unless reader explicitly subscribed to backlinksCell)
    expect(readerRunCount).toBe(1);
  });

  it("content-based IDs produce deterministic entity IDs", async () => {
    // This test verifies that content-based [ID] hashing produces
    // deterministic entity IDs for identical content.
    //
    // When you write [{name: "a"}] to a cell:
    // 1. recursivelyAddIDIfNeeded adds [ID]: refer(value).toString() (content hash)
    // 2. createRef uses this [ID] to compute entity ID
    // 3. Same content = same hash = same entity ID
    //
    // This enables Merkle interning: stored links have the same ID,
    // so reference equality is preserved and notifications are skipped.

    const charmList = runtime.getCell<{ name: string }[]>(
      space,
      "counter-id-test",
      undefined,
      tx,
    );

    // First write
    charmList.set([{ name: "test-charm" }]);
    await tx.commit();
    tx = runtime.edit();

    // Get raw stored value (the link)
    const stored1 = JSON.stringify(charmList.getRaw());
    console.log(`[counter-test] After first write: ${stored1}`);

    // Extract entity ID from the link
    const match1 = stored1.match(/"id":"([^"]+)"/);
    const entityId1 = match1?.[1];
    console.log(`[counter-test] First entity ID: ${entityId1}`);

    // Second write with IDENTICAL content
    charmList.withTx(tx).set([{ name: "test-charm" }]);
    await tx.commit();
    tx = runtime.edit();

    const stored2 = JSON.stringify(charmList.getRaw());
    console.log(`[counter-test] After second write: ${stored2}`);

    const match2 = stored2.match(/"id":"([^"]+)"/);
    const entityId2 = match2?.[1];
    console.log(`[counter-test] Second entity ID: ${entityId2}`);

    console.log(`[counter-test] Entity IDs equal: ${entityId1 === entityId2}`);
    console.log(`[counter-test] Stored values equal: ${stored1 === stored2}`);

    // With content-based hashing, entity IDs should be the same
    expect(entityId1).toBe(entityId2);
    // And stored values should be reference-equal
    expect(stored1).toBe(stored2);
  });
});

describe("notification fan-out", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should demonstrate O(N) write fan-out (BacklinksIndex pattern)", async () => {
    // This simulates the BacklinksIndex pattern where:
    // 1. A list of items exists
    // 2. An "index builder" action reads the list and WRITES to each item
    // 3. Adding a new item triggers the index builder to write to ALL items
    //
    // This creates O(N) writes for each list change, which can cause
    // O(N²) notifications if each item has subscribers.

    const NUM_ITEMS = 20; // Simulate 20 charms

    // Create a list and N items
    const itemList = runtime.getCell<string[]>(
      space,
      "backlinks-fanout-list",
      undefined,
      tx,
    );
    itemList.set([]);

    // Create cells for each item's "backlinks"
    const backlinks: ReturnType<typeof runtime.getCell>[] = [];
    for (let i = 0; i < NUM_ITEMS; i++) {
      const bl = runtime.getCell<string[]>(
        space,
        `backlinks-fanout-item-${i}`,
        undefined,
        tx,
      );
      bl.set([]);
      backlinks.push(bl);
    }

    await tx.commit();
    tx = runtime.edit();

    let indexBuilderRuns = 0;
    let totalWrites = 0;
    let itemSubscriberRuns = 0;

    // "Index builder" action - like BacklinksIndex's computeIndex
    // Reads the list, writes to EVERY item
    const indexBuilder: Action = (actionTx) => {
      indexBuilderRuns++;
      const list = itemList.withTx(actionTx).get();

      // For each item in list, write to its backlinks (simulating backlinks.set([]))
      for (let i = 0; i < list.length; i++) {
        totalWrites++;
        backlinks[i].withTx(actionTx).set([`rebuilt-${indexBuilderRuns}`]);
      }

      console.log(
        `[fanout-test] indexBuilder run ${indexBuilderRuns}: list.length=${list.length}, writes=${totalWrites}`,
      );
    };

    // Subscribe some items to their own backlinks (simulating charms that render backlinks)
    const itemSubscribers: Action[] = [];
    for (let i = 0; i < 5; i++) {
      const subscriber: Action = (actionTx) => {
        itemSubscriberRuns++;
        // Read backlinks
        backlinks[i].withTx(actionTx).get();
      };
      itemSubscribers.push(subscriber);
    }

    // Subscribe the index builder
    runtime.scheduler.subscribe(indexBuilder, { reads: [], writes: [] }, true);
    await runtime.idle();

    // Subscribe item subscribers
    for (const sub of itemSubscribers) {
      runtime.scheduler.subscribe(sub, { reads: [], writes: [] }, true);
      await runtime.idle();
    }

    console.log(`[fanout-test] After initial setup: indexBuilder=${indexBuilderRuns}, itemSubscribers=${itemSubscriberRuns}`);

    // Now add items to the list one by one
    const startTime = Date.now();
    for (let i = 0; i < NUM_ITEMS; i++) {
      const current = itemList.withTx(tx).get();
      itemList.withTx(tx).set([...current, `item-${i}`]);
      await tx.commit();
      tx = runtime.edit();
      await runtime.idle();
    }
    const elapsed = Date.now() - startTime;

    console.log(`[fanout-test] After adding ${NUM_ITEMS} items:`);
    console.log(`  - indexBuilder runs: ${indexBuilderRuns}`);
    console.log(`  - total writes: ${totalWrites}`);
    console.log(`  - itemSubscriber runs: ${itemSubscriberRuns}`);
    console.log(`  - elapsed: ${elapsed}ms`);

    // With O(N) writes per list change, and N list changes:
    // - indexBuilder should run ~N times (once per list change)
    // - totalWrites should be O(N²) = sum(1 + 2 + 3 + ... + N) = N*(N+1)/2
    // - itemSubscriberRuns depends on how many items have subscribers

    // This is the key metric: for N=20 items, we expect:
    // - ~20 indexBuilder runs
    // - ~210 total writes (1+2+3+...+20 = 210)
    const expectedTotalWrites = (NUM_ITEMS * (NUM_ITEMS + 1)) / 2;
    console.log(`  - expected writes: ${expectedTotalWrites}`);

    // The test passes, but demonstrates the O(N²) behavior
    expect(totalWrites).toBe(expectedTotalWrites);
  });
});

describe("reactive retries", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it(
    "should retry reactive actions when commit fails, up to limit",
    async () => {
      // Establish a source cell to create a read dependency
      const source = runtime.getCell<number>(
        space,
        "should retry reactive actions when commit fails, up to limit 1",
        undefined,
        tx,
      );
      source.set(1);
      await tx.commit();
      tx = runtime.edit();

      // Count runs; force commit failure each time
      let attempts = 0;
      const reactiveAction: Action = (actionTx) => {
        attempts++;
        // Read to establish dependency so later changes re-trigger
        source.withTx(actionTx).get();
        // Force commit to fail so scheduler retries
        actionTx.abort("force-abort-for-reactive-retry");
      };

      // Subscribe and run immediately
      runtime.scheduler.subscribe(
        reactiveAction,
        { reads: [], writes: [] },
        true,
      );

      // Allow retries to process. Idle may resolve before re-queue occurs,
      // so loop a few times until attempts reach the expected amount.
      for (let i = 0; i < 20 && attempts < 10; i++) {
        await runtime.idle();
      }

      // MAX_RETRIES_FOR_REACTIVE is 10; expect initial + retries == 10 attempts
      expect(attempts).toBe(10);

      // After reaching retry limit, a subsequent input change should re-trigger
      source.withTx(tx).send(2);
      await tx.commit();
      tx = runtime.edit();

      // Wait for the follow-up run
      await runtime.idle();

      expect(attempts).toBe(11);
    },
  );

  it(
    "should preserve dependencies when retrying failed commits",
    async () => {
      // This test documents expected behavior for the conflict storm fix:
      // When a reactive action's commit fails and it retries, it should
      // preserve its dependency information (not overwrite with empty deps).
      // This ensures topological sorting works correctly during retries.
      //
      // NOTE: This test passes with both buggy and fixed code because line 274
      // immediately re-learns dependencies after each action run, masking the
      // bug in simple scenarios. The real bug manifests only in high-concurrency
      // scenarios (30+ reactive cells) where async commit callbacks race with
      // scheduler execution. See budget-planner integration test for evidence
      // of the fix (conflict storm: 65k errors → 1 error after fix).

      const source = runtime.getCell<number>(
        space,
        "should preserve dependencies source",
        undefined,
        tx,
      );
      source.set(1);

      const intermediate = runtime.getCell<number>(
        space,
        "should preserve dependencies intermediate",
        undefined,
        tx,
      );
      intermediate.set(0);

      const output = runtime.getCell<number>(
        space,
        "should preserve dependencies output",
        undefined,
        tx,
      );
      output.set(0);

      await tx.commit();
      tx = runtime.edit();

      let action1Attempts = 0;
      let action2Attempts = 0;
      const action2Values: number[] = [];

      // Action 1: reads source, writes intermediate (will fail first 2 times)
      const action1: Action = (actionTx) => {
        action1Attempts++;
        const val = source.withTx(actionTx).get();
        intermediate.withTx(actionTx).send(val * 10);

        // Force abort for first 2 attempts to trigger retry logic
        if (action1Attempts <= 2) {
          actionTx.abort("force-abort-action1");
        }
      };

      // Action 2: reads intermediate, writes output (depends on action1)
      const action2: Action = (actionTx) => {
        action2Attempts++;
        const val = intermediate.withTx(actionTx).get();
        action2Values.push(val);
        output.withTx(actionTx).send(val + 5);
      };

      // Subscribe both actions with correct dependencies
      runtime.scheduler.subscribe(
        action1,
        {
          reads: [source.getAsNormalizedFullLink()],
          writes: [intermediate.getAsNormalizedFullLink()],
        },
        true,
      );
      runtime.scheduler.subscribe(
        action2,
        {
          reads: [intermediate.getAsNormalizedFullLink()],
          writes: [output.getAsNormalizedFullLink()],
        },
        true,
      );

      // Allow all actions to complete (action1 will retry twice)
      for (let i = 0; i < 20 && action1Attempts < 3; i++) {
        await runtime.idle();
      }

      // Verify action1 ran 3 times (2 aborts + 1 success)
      expect(action1Attempts).toBe(3);

      // Action2 should run twice in reactive system:
      // 1. Initially when both actions run (sees intermediate=0 since action1 aborts)
      // 2. After action1 succeeds and updates intermediate (sees intermediate=10)
      expect(action2Attempts).toBe(2);
      expect(action2Values).toEqual([0, 10]);

      // Critical assertion: The final state must be correct, proving that
      // dependencies were preserved during retries and topological sort worked.
      expect(intermediate.get()).toBe(10); // 1 * 10
      expect(output.get()).toBe(15); // 10 + 5
    },
  );
});

describe("Stream event success callbacks", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
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

  it("should call onCommit callback after Stream event commits successfully", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    let callbackCalled = false;
    let callbackTx: IExtendedStorageTransaction | undefined;

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      undefined,
      (committedTx) => {
        callbackCalled = true;
        callbackTx = committedTx;
      },
    );

    expect(callbackCalled).toBe(false);
    await runtime.idle();
    await runtime.storageManager.synced();
    expect(callbackCalled).toBe(true);
    expect(callbackTx).toBeDefined();
    expect(resultCell.get()).toBe(42);
  });

  it("should call callback after all retries succeed", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-retry-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-retry-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let eventHandlerCalls = 0;
    let callbackCalls = 0;

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        eventHandlerCalls++;
        // Fail first time, succeed second time
        if (eventHandlerCalls === 1) {
          tx.abort("Intentional failure for test");
          return;
        }
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      undefined,
      () => {
        callbackCalls++;
      },
    );

    await runtime.idle();
    await runtime.idle(); // Wait for retry
    await runtime.storageManager.synced();

    // Callback should be called only once after retry succeeds
    expect(callbackCalls).toBe(1);
    expect(eventHandlerCalls).toBe(2); // Called twice (fail then succeed)
    expect(resultCell.get()).toBe(42);
  });

  it("should handle errors in stream callbacks gracefully", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-error-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-error-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    let callback1Called = false;
    let callback2Called = false;

    // Send two events
    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      1,
      undefined,
      () => {
        callback1Called = true;
        throw new Error("Callback error");
      },
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      2,
      undefined,
      () => {
        callback2Called = true;
      },
    );

    await runtime.idle();
    await runtime.storageManager.synced();

    // Both callbacks should be called despite first one throwing
    expect(callback1Called).toBe(true);
    expect(callback2Called).toBe(true);
    expect(resultCell.get()).toBe(2); // Last event processed
  });

  it("should allow stream operations without callback", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-optional-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-optional-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    runtime.scheduler.addEventHandler(
      (tx, event) => {
        resultCell.withTx(tx).send(event);
      },
      eventCell.getAsNormalizedFullLink(),
    );

    // Should work fine without callback (backward compatible)
    runtime.scheduler.queueEvent(eventCell.getAsNormalizedFullLink(), 42);
    await runtime.idle();
    expect(resultCell.get()).toBe(42);
  });

  it("should call onCommit callback even when event fails after all retries", async () => {
    const eventCell = runtime.getCell<number>(
      space,
      "stream-callback-final-fail-test",
      undefined,
      tx,
    );
    eventCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    const resultCell = runtime.getCell<number>(
      space,
      "stream-callback-final-fail-result",
      undefined,
      tx,
    );
    resultCell.set(0);
    await tx.commit();
    tx = runtime.edit();

    let eventHandlerCalls = 0;
    let callbackCalls = 0;
    let callbackTx: IExtendedStorageTransaction | undefined;

    runtime.scheduler.addEventHandler(
      (tx, _event) => {
        eventHandlerCalls++;
        // Always fail
        tx.abort("Intentional failure - should exhaust retries");
      },
      eventCell.getAsNormalizedFullLink(),
    );

    runtime.scheduler.queueEvent(
      eventCell.getAsNormalizedFullLink(),
      42,
      2, // Only 2 retries, so fails faster
      (tx) => {
        callbackCalls++;
        callbackTx = tx;
      },
    );

    await runtime.idle();
    await runtime.idle(); // Retry 1
    await runtime.idle(); // Retry 2 (final)
    await runtime.storageManager.synced();

    // Callback should be called once even though all attempts failed
    expect(callbackCalls).toBe(1);
    expect(eventHandlerCalls).toBe(3); // Initial + 2 retries
    expect(callbackTx).toBeDefined();
    // Transaction should show it failed
    const status = callbackTx!.status();
    expect(status.status).toBe("error");
  });
});
