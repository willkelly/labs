import * as FS from "@std/fs";
import * as Path from "@std/path";

import * as MemoryError from "./error.ts";
import * as Space from "./space.ts";
import {
  addChangesAttributes,
  addMemoryAttributes,
  traceAsync,
  traceSync,
} from "./telemetry.ts";
import {
  AsyncResult,
  ConnectionError,
  MemorySession,
  MemorySpace as Subject,
  Query,
  QueryResult,
  Result,
  SchemaQuery,
  Selection,
  SpaceSession,
  Subscriber,
  SubscribeResult,
  SystemError,
  Transaction,
  TransactionResult,
} from "./interface.ts";
export * from "./interface.ts";
import { type DID } from "@commontools/identity";
import { defer, type Deferred } from "@commontools/utils/defer";
import {
  createErrorResponse,
  isReadyMessage,
  isWorkerResponse,
  MessageType,
  type WorkerResponse,
} from "./worker/protocol.ts";
import { deserializeSelection } from "./worker/serializer.ts";

interface Session {
  store: URL;
  subscribers: Set<Subscriber>;
  spaces: Map<string, SpaceSession>;
}

// =============================================================================
// Read Worker Controller
// Manages a worker that executes read queries using a connection pool.
// =============================================================================

const DEFAULT_WORKER_TIMEOUT = 30_000; // 30 seconds
const DEFAULT_POOL_SIZE = 10;

enum WorkerState {
  Uninitialized = "uninitialized",
  Initializing = "initializing",
  Ready = "ready",
  Terminating = "terminating",
  Terminated = "terminated",
  Error = "error",
}

interface PendingRequest {
  deferred: Deferred<Selection>;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Controller for a read worker that handles concurrent read queries.
 * Each space gets its own worker with a pool of read-only connections.
 */
class ReadWorkerController {
  private worker: Worker;
  private state = WorkerState.Uninitialized;
  private msgId = 0;
  private pending = new Map<number, PendingRequest>();
  private initDeferred = defer<void>();
  private timeoutMs: number;

  constructor(
    private spaceUrl: URL,
    private subject: string,
    private poolSize: number = DEFAULT_POOL_SIZE,
    timeoutMs?: number,
  ) {
    this.timeoutMs = timeoutMs ?? DEFAULT_WORKER_TIMEOUT;

    this.worker = new Worker(
      new URL("./worker/read-worker.ts", import.meta.url).href,
      {
        type: "module",
        name: `read-worker-${subject}`,
      },
    );

    this.worker.addEventListener("message", this.onMessage);
    this.worker.addEventListener("error", this.onError);
  }

  /**
   * Initialize the worker and its connection pool.
   */
  async initialize(): Promise<void> {
    if (this.state !== WorkerState.Uninitialized) {
      throw new Error(`Cannot initialize worker in state: ${this.state}`);
    }
    this.state = WorkerState.Initializing;

    try {
      await this.initDeferred.promise;

      // Send init message
      await this.exec(MessageType.Init, {
        spaceUrl: this.spaceUrl.toString(),
        subject: this.subject,
        poolSize: this.poolSize,
      });

      this.state = WorkerState.Ready;
    } catch (error) {
      this.state = WorkerState.Error;
      throw error;
    }
  }

  /**
   * Execute a query on the worker.
   */
  async query(source: Query): Promise<Result<Selection, Error>> {
    if (this.state !== WorkerState.Ready) {
      throw new Error(`Worker not ready: ${this.state}`);
    }

    try {
      const result = await this.exec(MessageType.Query, {
        args: source.args,
      });
      return { ok: result as Selection };
    } catch (error) {
      return { error: error as Error };
    }
  }

  /**
   * Execute a schema query on the worker.
   */
  async querySchema(source: SchemaQuery): Promise<Result<Selection, Error>> {
    if (this.state !== WorkerState.Ready) {
      throw new Error(`Worker not ready: ${this.state}`);
    }

    try {
      const result = await this.exec(MessageType.QuerySchema, {
        args: source.args,
      });
      return { ok: result as Selection };
    } catch (error) {
      return { error: error as Error };
    }
  }

  /**
   * Close the worker and cleanup resources.
   */
  async close(): Promise<void> {
    if (
      this.state === WorkerState.Terminating ||
      this.state === WorkerState.Terminated
    ) {
      return;
    }

    this.state = WorkerState.Terminating;

    // Reject all pending requests
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.deferred.reject(new Error("Worker shutting down"));
    }
    this.pending.clear();

    try {
      await this.exec(MessageType.Close, {});
    } catch {
      // Ignore close errors
    }

    this.worker.terminate();
    this.state = WorkerState.Terminated;
  }

  /**
   * Check if the worker is ready.
   */
  isReady(): boolean {
    return this.state === WorkerState.Ready;
  }

  private exec(type: MessageType, data: Record<string, unknown>): Promise<unknown> {
    const msgId = this.msgId++;
    const deferred = defer<Selection>();

    const timeout = setTimeout(() => {
      this.pending.delete(msgId);
      deferred.reject(new Error(`Worker request timed out after ${this.timeoutMs}ms`));
    }, this.timeoutMs);

    this.pending.set(msgId, { deferred, timeout });

    this.worker.postMessage({ type, msgId, ...data });

    return deferred.promise;
  }

  private onMessage = (event: MessageEvent) => {
    const data = event.data;

    // Handle ready message
    if (isReadyMessage(data)) {
      this.initDeferred.resolve();
      return;
    }

    // Handle response
    if (!isWorkerResponse(data)) {
      console.error("Read worker: Invalid response:", data);
      return;
    }

    const pending = this.pending.get(data.msgId);
    if (!pending) {
      console.error("Read worker: No pending request for msgId:", data.msgId);
      return;
    }

    this.pending.delete(data.msgId);
    clearTimeout(pending.timeout);

    if (data.ok) {
      // Deserialize result if needed
      if ("resultBuffer" in data && data.resultBuffer) {
        const selection = deserializeSelection(data.resultBuffer);
        pending.deferred.resolve(selection);
      } else {
        pending.deferred.resolve(data.result as Selection);
      }
    } else {
      const error = new Error(data.error.message);
      error.name = data.error.name;
      pending.deferred.reject(error);
    }
  };

  private onError = (event: ErrorEvent) => {
    console.error("Read worker error:", event);
    event.preventDefault();

    this.state = WorkerState.Error;

    // Reject all pending requests
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.deferred.reject(new Error("Worker error: " + event.message));
    }
    this.pending.clear();

    this.worker.terminate();
  };
}

// =============================================================================
// Memory Class
// =============================================================================

export class Memory implements Session, MemorySession {
  store: URL;
  ready: Promise<unknown>;
  #serviceDid: DID;
  #readWorkers: Map<Subject, ReadWorkerController> = new Map();
  #workerInitPromises: Map<Subject, Promise<ReadWorkerController>> = new Map();

  constructor(
    options: Options,
    public subscribers: Set<Subscriber> = new Set(),
    public spaces: Map<Subject, SpaceSession> = new Map(),
  ) {
    this.store = options.store;
    this.ready = Promise.resolve();
    this.#serviceDid = options.serviceDid;
  }
  clone() {
    return new Memory(
      { store: this.store, serviceDid: this.serviceDid() },
      new Set(this.subscribers),
      new Map(this.spaces),
    );
  }

  serviceDid(): DID {
    return this.#serviceDid;
  }

  get memory() {
    return this;
  }

  /**
   * Runs task one at a time. Used for write operations (transact).
   * Read operations now use the worker pool for concurrency.
   */
  async perform<Out>(task: () => Promise<Out>): Promise<Out> {
    return await traceAsync("memory.perform", async (_span) => {
      const result = this.ready.finally().then(task);
      this.ready = result.finally();
      await this.ready;
      return await result;
    });
  }

  /**
   * Check if this is an in-memory database (workers can't share memory DBs).
   */
  private isInMemory(): boolean {
    return this.store.protocol === "memory:";
  }

  /**
   * Get or create a read worker for the given space.
   * Workers are lazily initialized on first read to each space.
   * Returns null for in-memory databases (workers can't share them).
   */
  private async getReadWorker(subject: Subject): Promise<ReadWorkerController | null> {
    // In-memory databases can't be shared across workers
    if (this.isInMemory()) {
      return null;
    }

    // Return existing ready worker
    const existing = this.#readWorkers.get(subject);
    if (existing?.isReady()) {
      return existing;
    }

    // Check if initialization is in progress
    const initPromise = this.#workerInitPromises.get(subject);
    if (initPromise) {
      return initPromise;
    }

    // Create and initialize new worker
    const isFile = Path.extname(this.store.pathname) !== "";
    const spaceUrl = isFile
      ? this.store
      : new URL(`./${subject}.sqlite`, this.store);

    const worker = new ReadWorkerController(spaceUrl, subject);

    // Store the initialization promise to prevent duplicate workers
    const promise = (async () => {
      await worker.initialize();
      this.#readWorkers.set(subject, worker);
      this.#workerInitPromises.delete(subject);
      return worker;
    })();

    this.#workerInitPromises.set(subject, promise);
    return promise;
  }

  subscribe(subscriber: Subscriber): SubscribeResult {
    return subscribe(this, subscriber);
  }

  unsubscribe(subscriber: Subscriber): SubscribeResult {
    return unsubscribe(this, subscriber);
  }

  /**
   * Execute a write transaction. Writes are serialized through perform().
   */
  transact(transaction: Transaction): TransactionResult {
    return this.perform(() => transact(this, transaction));
  }

  /**
   * Execute a read query. Reads are concurrent via the worker pool.
   * Falls back to main thread for in-memory databases.
   */
  query(source: Query): QueryResult {
    return traceAsync("memory.query", async (span) => {
      addMemoryAttributes(span, {
        operation: "query",
        space: source.sub,
      });

      // Try to use worker for concurrent reads
      const worker = await this.getReadWorker(source.sub);
      if (worker) {
        span.setAttribute("query.mode", "worker");
        try {
          const result = await worker.query(source);
          if (result.error) {
            span.setAttribute("query.status", "error");
            return { error: MemoryError.query(source.sub, source.args.select, result.error as SystemError) };
          }
          span.setAttribute("query.status", "success");
          return { ok: result.ok };
        } catch (error) {
          span.setAttribute("query.status", "error");
          span.setAttribute("query.error", String(error));
          return { error: MemoryError.query(source.sub, source.args.select, error as SystemError) };
        }
      }

      // Fall back to main thread for in-memory databases
      span.setAttribute("query.mode", "main-thread");
      return await this.perform(() => query(this, source));
    });
  }

  /**
   * Execute a schema query. Reads are concurrent via the worker pool.
   * Falls back to main thread for in-memory databases.
   */
  querySchema(source: SchemaQuery): QueryResult {
    return traceAsync("memory.querySchema", async (span) => {
      addMemoryAttributes(span, {
        operation: "querySchema",
        space: source.sub,
      });

      // Try to use worker for concurrent reads
      const worker = await this.getReadWorker(source.sub);
      if (worker) {
        span.setAttribute("querySchema.mode", "worker");
        try {
          const result = await worker.querySchema(source);
          if (result.error) {
            span.setAttribute("querySchema.status", "error");
            return { error: MemoryError.query(source.sub, source.args.selectSchema, result.error as SystemError) };
          }
          span.setAttribute("querySchema.status", "success");
          return { ok: result.ok };
        } catch (error) {
          span.setAttribute("querySchema.status", "error");
          span.setAttribute("querySchema.error", String(error));
          return { error: MemoryError.query(source.sub, source.args.selectSchema, error as SystemError) };
        }
      }

      // Fall back to main thread for in-memory databases
      span.setAttribute("querySchema.mode", "main-thread");
      return await this.perform(() => querySchema(this, source));
    });
  }

  /**
   * Close the memory session and all workers.
   */
  async close() {
    // Close all read workers first (not in perform() to allow cleanup)
    const workerClosePromises: Promise<void>[] = [];
    for (const worker of this.#readWorkers.values()) {
      workerClosePromises.push(worker.close());
    }
    await Promise.all(workerClosePromises);
    this.#readWorkers.clear();
    this.#workerInitPromises.clear();

    // Then close the main session (serialized)
    return this.perform(() => close(this));
  }
}

/**
 * Subscribes a subscriber to memory changes.
 * @param session - The memory session
 * @param subscriber - The subscriber to add
 * @returns Success result
 */
export const subscribe = (session: Session, subscriber: Subscriber) => {
  return traceSync("memory.subscribe", (span) => {
    addMemoryAttributes(span, { operation: "subscribe" });
    session.subscribers.add(subscriber);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);
    return { ok: {} };
  });
};

/**
 * Unsubscribes a subscriber from memory changes.
 * @param session - The memory session
 * @param subscriber - The subscriber to remove
 * @returns Success result
 */
export const unsubscribe = (session: Session, subscriber: Subscriber) => {
  return traceSync("memory.unsubscribe", (span) => {
    addMemoryAttributes(span, { operation: "unsubscribe" });
    session.subscribers.delete(subscriber);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);
    return { ok: {} };
  });
};

export const query = async (session: Session, query: Query) => {
  return await traceAsync("memory.query", async (span) => {
    addMemoryAttributes(span, {
      operation: "query",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    return space.query(query);
  });
};

export const querySchema = async (session: Session, query: SchemaQuery) => {
  return await traceAsync("memory.querySchema", async (span) => {
    addMemoryAttributes(span, {
      operation: "querySchema",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    return space.querySchema(query);
  });
};

/**
 * Internal variant of querySchema that also returns the schemaTracker.
 * Used by provider.ts for incremental subscription updates.
 *
 * @param existingSchemaTracker - Optional existing tracker to reuse. When provided,
 * the query will skip traversing docs that are already tracked with the same schema,
 * providing early termination for overlapping subscriptions.
 */
export const querySchemaWithTracker = async (
  session: Session,
  query: SchemaQuery,
  existingSchemaTracker?: Space.SelectSchemaResult["schemaTracker"],
) => {
  return await traceAsync("memory.querySchemaWithTracker", async (span) => {
    addMemoryAttributes(span, {
      operation: "querySchemaWithTracker",
      space: query.sub,
    });

    const { ok: space, error } = await mount(session, query.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    // Cast is safe: the Space class implements both SpaceSession and Session<Subject>
    return Space.querySchemaWithTracker(
      space as unknown as Space.Session<typeof query.sub>,
      query,
      existingSchemaTracker,
    );
  });
};

export const transact = async (session: Session, transaction: Transaction) => {
  return await traceAsync("memory.transact", async (span) => {
    addMemoryAttributes(span, {
      operation: "transact",
      space: transaction.sub,
    });

    if (transaction.args?.changes) {
      addChangesAttributes(span, transaction.args.changes);
    }

    const { ok: space, error } = await mount(session, transaction.sub);
    if (error) {
      span.setAttribute("mount.status", "error");
      return { error };
    }

    span.setAttribute("mount.status", "success");
    const result = space.transact(transaction);

    if (result.error) {
      return result;
    } else {
      return await traceAsync(
        "memory.notify_subscribers",
        async (notifySpan) => {
          notifySpan.setAttribute(
            "memory.subscriber_count",
            session.subscribers.size,
          );

          const promises = [];
          // Copy here, in case a subscriber modifies the set of subscribers
          for (const subscriber of [...session.subscribers]) {
            promises.push(subscriber.commit(result.ok));
          }
          await Promise.all(promises);

          return result;
        },
      );
    }
  });
};

export const mount = async (
  session: Session,
  subject: Subject,
): Promise<Result<SpaceSession, ConnectionError>> => {
  return await traceAsync("memory.mount", async (span) => {
    addMemoryAttributes(span, {
      operation: "mount",
      space: subject,
    });

    const space = session.spaces.get(subject);
    if (space) {
      span.setAttribute("memory.mount.cache", "hit");
      return { ok: space };
    } else {
      span.setAttribute("memory.mount.cache", "miss");

      // Detect if store path is a file (has extension) or directory
      const isFile = Path.extname(session.store.pathname) !== "";

      // If store is a file: use it directly (e.g., /data/spaces/xyz/5/space.db)
      // If store is a directory: create per-space files (e.g., /cache/memory/did:key:z6Mkr4....sqlite)
      const spaceUrl = isFile
        ? session.store
        : new URL(`./${subject}.sqlite`, session.store);

      const result = await Space.open({
        url: spaceUrl,
      });

      if (result.error) {
        return result;
      }

      const replica = result.ok as SpaceSession;
      session.spaces.set(subject, replica);
      span.setAttribute("memory.spaces_count", session.spaces.size);
      return { ok: replica };
    }
  });
};

export interface ServiceOptions {
  serviceDid: DID;
}

export interface Options extends ServiceOptions {
  store: URL;
}

export const open = async (
  options: Options,
): AsyncResult<Memory, ConnectionError> => {
  return await traceAsync("memory.open", async (span) => {
    addMemoryAttributes(span, { operation: "open" });
    span.setAttribute("memory.store_url", options.store.toString());

    try {
      if (options.store.protocol === "file:") {
        // Check if path has a file extension (single-file mode) or is a directory
        const isFile = Path.extname(options.store.pathname) !== "";

        if (isFile) {
          // Ensure parent directory exists for single-file mode
          const parentDir = Path.dirname(options.store.pathname);
          await FS.ensureDir(Path.toFileUrl(parentDir));
        } else {
          // Ensure directory exists for directory mode
          await FS.ensureDir(options.store);
        }
      }
      return { ok: await new Memory(options) };
    } catch (cause) {
      return { error: MemoryError.connection(options.store, cause as SystemError) };
    }
  });
};

/**
 * Creates an ephemeral memory session. It will not persist
 * anything and it's primary use is in testing.
 */
export const emulate = (options: ServiceOptions) =>
  new Memory({
    ...options,
    store: new URL("memory://"),
  });

export const close = async (session: Session) => {
  return await traceAsync("memory.close", async (span) => {
    addMemoryAttributes(span, { operation: "close" });
    span.setAttribute("memory.spaces_count", session.spaces.size);
    span.setAttribute("memory.subscriber_count", session.subscribers.size);

    const promises = [];
    for (const replica of session.spaces.values()) {
      promises.push(replica.close());
    }

    for (const subscriber of session.subscribers) {
      promises.push(subscriber.close());
    }

    const results = await Promise.all(promises);
    const result = results.find((result) => result?.error);
    return result ?? { ok: {} };
  });
};
