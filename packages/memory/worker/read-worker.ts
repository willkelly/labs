/// <reference lib="deno.worker" />

/**
 * Read Worker for the Memory module.
 * Executes read queries using a pool of read-only SQLite connections.
 * Runs in a separate thread for concurrent read access.
 */

import { ReadConnectionPool } from "./read-pool.ts";
import {
  createErrorResponse,
  isWorkerRequest,
  MessageType,
  type CloseMessage,
  type InitMessage,
  type QueryMessage,
  type QuerySchemaMessage,
  type SuccessResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.ts";
import {
  serializeSelection,
  shouldUseBinaryTransfer,
} from "./serializer.ts";
import {
  executeQuery,
  executeSchemaQuery,
  type MemorySpace,
  type Selection,
} from "../space.ts";

// Worker state
let pool: ReadConnectionPool | null = null;
let spaceSubject: string | null = null;

/**
 * Handle initialization message - create the connection pool.
 */
async function handleInit(msg: InitMessage): Promise<WorkerResponse> {
  try {
    if (pool) {
      pool.close();
    }

    spaceSubject = msg.subject;
    pool = new ReadConnectionPool(msg.spaceUrl, msg.poolSize);
    await pool.initialize();

    return {
      msgId: msg.msgId,
      ok: true,
      result: { poolSize: pool.size },
    };
  } catch (error) {
    return createErrorResponse(msg.msgId, error);
  }
}

/**
 * Handle query message - execute a read query.
 */
function handleQuery(msg: QueryMessage): WorkerResponse {
  try {
    if (!pool || !spaceSubject) {
      throw new Error("Worker not initialized");
    }

    const conn = pool.acquire();
    try {
      const factSelection = executeQuery(
        conn.db,
        spaceSubject as MemorySpace,
        msg.args,
      );

      // Wrap in Selection format
      const selection: Selection = {
        [spaceSubject]: factSelection,
      } as Selection;

      // Decide transfer method based on size
      if (shouldUseBinaryTransfer(selection)) {
        const buffer = serializeSelection(selection);
        return {
          msgId: msg.msgId,
          ok: true,
          resultBuffer: buffer,
        };
      } else {
        return {
          msgId: msg.msgId,
          ok: true,
          result: selection,
        };
      }
    } finally {
      pool.release(conn);
    }
  } catch (error) {
    return createErrorResponse(msg.msgId, error);
  }
}

/**
 * Handle schema query message - execute a schema read query.
 */
function handleQuerySchema(msg: QuerySchemaMessage): WorkerResponse {
  try {
    if (!pool || !spaceSubject) {
      throw new Error("Worker not initialized");
    }

    const conn = pool.acquire();
    try {
      const factSelection = executeSchemaQuery(
        conn.db,
        spaceSubject as MemorySpace,
        msg.args,
      );

      // Wrap in Selection format
      const selection: Selection = {
        [spaceSubject]: factSelection,
      } as Selection;

      // Decide transfer method based on size
      if (shouldUseBinaryTransfer(selection)) {
        const buffer = serializeSelection(selection);
        return {
          msgId: msg.msgId,
          ok: true,
          resultBuffer: buffer,
        };
      } else {
        return {
          msgId: msg.msgId,
          ok: true,
          result: selection,
        };
      }
    } finally {
      pool.release(conn);
    }
  } catch (error) {
    return createErrorResponse(msg.msgId, error);
  }
}

/**
 * Handle close message - cleanup and close the pool.
 */
function handleClose(msg: CloseMessage): WorkerResponse {
  try {
    if (pool) {
      pool.close();
      pool = null;
    }
    spaceSubject = null;

    return {
      msgId: msg.msgId,
      ok: true,
    };
  } catch (error) {
    return createErrorResponse(msg.msgId, error);
  }
}

/**
 * Route message to appropriate handler.
 */
async function handleMessage(
  request: WorkerRequest,
): Promise<WorkerResponse> {
  switch (request.type) {
    case MessageType.Init:
      return await handleInit(request);
    case MessageType.Query:
      return handleQuery(request);
    case MessageType.QuerySchema:
      return handleQuerySchema(request);
    case MessageType.Close:
      return handleClose(request);
  }
}

// Message handler
self.addEventListener("message", async (event: MessageEvent) => {
  const request = event.data;
  if (!isWorkerRequest(request)) {
    console.error("Read worker: Invalid request:", request);
    return;
  }

  const response = await handleMessage(request);

  // Use transfer for ArrayBuffer results (zero-copy)
  if ("resultBuffer" in response && response.resultBuffer) {
    self.postMessage(response, [response.resultBuffer]);
  } else {
    self.postMessage(response);
  }
});

// Signal that worker is ready
self.postMessage({ type: "ready", msgId: -1 });
