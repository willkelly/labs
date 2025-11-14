/**
 * SQLite Connection Pool for Concurrent Reads
 *
 * This pool maintains multiple SQLite database connections to enable
 * concurrent read operations while maintaining a single writer pattern.
 *
 * Requirements:
 * - Database must be in WAL mode to support concurrent readers
 * - All connections share the same underlying database file
 * - Write operations should still use the main session connection
 */

import { Database } from "@db/sqlite";

export interface PoolOptions {
  /** Number of concurrent read connections to maintain */
  poolSize?: number;
  /** Path to the database file (or :memory:) */
  path: URL | string;
  /** Whether to create the database if it doesn't exist */
  create?: boolean;
}

export class SQLiteConnectionPool {
  private connections: Database[] = [];
  private available: Database[] = [];
  private waiting: Array<(conn: Database) => void> = [];
  private closed = false;

  constructor(private options: PoolOptions) {
    const poolSize = options.poolSize ?? 4;

    // Create all connections upfront
    for (let i = 0; i < poolSize; i++) {
      const conn = new Database(options.path, {
        create: options.create ?? false,
        // Read-only connections for the pool (except the main connection)
        // readonly: i > 0, // Commented out - may need write access for WAL checkpoints
      });

      // Apply performance optimizations to each connection
      conn.exec("PRAGMA journal_mode=WAL;");            // Enable WAL mode
      conn.exec("PRAGMA synchronous=NORMAL;");          // Faster commits (safe with WAL)
      conn.exec("PRAGMA cache_size=-64000;");           // 64MB cache per connection
      conn.exec("PRAGMA temp_store=MEMORY;");           // Temp tables in RAM
      conn.exec("PRAGMA mmap_size=268435456;");         // 256MB memory-mapped I/O

      this.connections.push(conn);
      this.available.push(conn);
    }
  }

  /**
   * Acquire a connection from the pool
   * Returns immediately if a connection is available, otherwise waits
   */
  async acquire(): Promise<Database> {
    if (this.closed) {
      throw new Error("Connection pool is closed");
    }

    // If we have an available connection, return it immediately
    if (this.available.length > 0) {
      return this.available.pop()!;
    }

    // Otherwise, wait for a connection to become available
    return new Promise((resolve) => {
      this.waiting.push(resolve);
    });
  }

  /**
   * Release a connection back to the pool
   */
  release(conn: Database): void {
    if (this.closed) {
      return;
    }

    // If someone is waiting, give it to them directly
    const waiter = this.waiting.shift();
    if (waiter) {
      waiter(conn);
    } else {
      // Otherwise, return it to the available pool
      this.available.push(conn);
    }
  }

  /**
   * Execute a function with an acquired connection, then release it
   */
  async withConnection<T>(fn: (conn: Database) => T | Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  /**
   * Close all connections in the pool
   */
  close(): void {
    if (this.closed) {
      return;
    }

    this.closed = true;

    // Reject all waiting promises
    for (const waiter of this.waiting) {
      waiter(null as any);
    }
    this.waiting = [];

    // Close all connections
    for (const conn of this.connections) {
      try {
        conn.close();
      } catch (error) {
        console.error("Error closing pool connection:", error);
      }
    }

    this.connections = [];
    this.available = [];
  }

  /**
   * Get pool statistics
   */
  getStats() {
    return {
      total: this.connections.length,
      available: this.available.length,
      inUse: this.connections.length - this.available.length,
      waiting: this.waiting.length,
    };
  }
}
