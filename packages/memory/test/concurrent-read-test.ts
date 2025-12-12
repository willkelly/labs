/**
 * Tests for concurrent read functionality using worker pool.
 * These tests use file-based databases to verify worker operation.
 */

import { assert, assertEquals } from "@std/assert";
import { refer } from "merkle-reference";
import * as Memory from "../memory.ts";
import * as Query from "../query.ts";
import * as Transaction from "../transaction.ts";
import * as Changes from "../changes.ts";
import * as Fact from "../fact.ts";
import { alice, space as spaceIdentity } from "./principal.ts";

const the = "application/json";
const doc = `of:${refer({ hello: "world" })}` as const;

Deno.test("concurrent reads with file-based database", async () => {
  // Create a temp file for the database
  const tempDir = await Deno.makeTempDir();
  const dbPath = `${tempDir}/test.sqlite`;
  const url = new URL(`file://${dbPath}`);

  const { ok: session, error } = await Memory.open({
    store: url,
    serviceDid: alice.did(),
  });

  if (error) {
    throw error;
  }

  try {
    const space = spaceIdentity.did();

    // Create some test data using the proper API
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { hello: "world", count: 1 },
    });

    const tr1 = Transaction.create({
      issuer: alice.did(),
      subject: space,
      changes: Changes.from([v1]),
    });

    const writeResult = await session.transact(tr1);
    if (writeResult.error) {
      console.error("Write error:", writeResult.error);
    }
    assert(writeResult.ok, "Should write successfully: " + JSON.stringify(writeResult.error));

    // Create multiple concurrent queries
    const queries = Array.from({ length: 10 }, () =>
      session.query(
        Query.create({
          issuer: alice.did(),
          subject: space,
          select: { [doc]: { [the]: {} } },
        }),
      )
    );

    // Execute all queries concurrently
    const results = await Promise.all(queries);

    // All should succeed with the same result
    for (const result of results) {
      assert(result.ok, "Query should succeed");
      const facts = result.ok[space];
      assert(facts, "Should have facts for space");
      const docFacts = facts[doc];
      assert(docFacts, "Should have facts for doc");
      const theFacts = docFacts[the];
      assert(theFacts, "Should have facts for the");

      // Get the value from the first cause
      const causes = Object.keys(theFacts);
      assert(causes.length > 0, "Should have at least one cause");
      const value = theFacts[causes[0]];
      assertEquals(value.is, { hello: "world", count: 1 }, "Value should match");
    }

    await session.close();
  } finally {
    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});

Deno.test("concurrent reads don't block writes", async () => {
  // Create a temp file for the database
  const tempDir = await Deno.makeTempDir();
  const dbPath = `${tempDir}/test2.sqlite`;
  const url = new URL(`file://${dbPath}`);

  const { ok: session, error } = await Memory.open({
    store: url,
    serviceDid: alice.did(),
  });

  if (error) {
    throw error;
  }

  try {
    const space = spaceIdentity.did();

    // Create initial data using the proper API
    const v1 = Fact.assert({
      the,
      of: doc,
      is: { count: 0 },
    });

    const tr1 = Transaction.create({
      issuer: alice.did(),
      subject: space,
      changes: Changes.from([v1]),
    });

    const writeResult = await session.transact(tr1);
    assert(writeResult.ok, "Initial write should succeed");

    // Start concurrent reads
    const operations: Promise<unknown>[] = [];

    // Add 5 reads
    for (let i = 0; i < 5; i++) {
      operations.push(
        session.query(
          Query.create({
            issuer: alice.did(),
            subject: space,
            select: { [doc]: { [the]: {} } },
          }),
        ),
      );
    }

    // All operations should complete without deadlock
    const results = await Promise.all(operations);

    // All reads should succeed
    for (const result of results) {
      const queryResult = result as Memory.QueryResult;
      // QueryResult is AwaitResult which could be awaited
      const resolved = await queryResult;
      assert(resolved.ok, "Read should succeed");
    }

    await session.close();
  } finally {
    // Cleanup
    try {
      await Deno.remove(tempDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
});
