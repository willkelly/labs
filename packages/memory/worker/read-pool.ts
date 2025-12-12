/**
 * Read-only connection pool for SQLite databases.
 * Manages a pool of read-only connections for concurrent query execution.
 */

import { Database, Statement } from "@db/sqlite";

// Read-only pragmas - no WAL checkpoint, enforces read-only mode
const READ_PRAGMAS = `
  PRAGMA journal_mode=WAL;
  PRAGMA synchronous=NORMAL;
  PRAGMA busy_timeout=5000;
  PRAGMA cache_size=-64000;
  PRAGMA temp_store=MEMORY;
  PRAGMA mmap_size=268435456;
  PRAGMA foreign_keys=ON;
  PRAGMA query_only=ON;
`;

/**
 * Convert a URL string to a database path.
 * file:// URLs are converted to file paths, memory:// URLs return ":memory:".
 */
function urlToDbPath(urlString: string): string {
  const url = new URL(urlString);
  if (url.protocol === "file:") {
    // For file URLs, use the pathname (URL decodes it automatically)
    return url.pathname;
  } else if (url.protocol === "memory:") {
    return ":memory:";
  }
  throw new Error(`Unsupported protocol: ${url.protocol}`);
}

// Prepared statement keys matching space.ts
type PreparedStatementKey =
  | "export"
  | "causeChain"
  | "getFact"
  | "getLabelsBatch";

// Prepared statement cache per connection
type PreparedStatements = Partial<Record<PreparedStatementKey, Statement>>;

/**
 * A pooled database connection with its prepared statement cache.
 */
export interface PooledConnection {
  db: Database;
  inUse: boolean;
  preparedStatements: PreparedStatements;
}

/**
 * Connection pool for read-only SQLite access.
 * Uses round-robin allocation. Since SQLite WAL mode allows concurrent reads,
 * connections can be reused even when marked "in use" - the flag is advisory.
 */
export class ReadConnectionPool {
  private connections: PooledConnection[] = [];
  private roundRobinIndex = 0;
  private initialized = false;

  constructor(
    private dbPath: string,
    private poolSize: number = 10,
  ) {}

  /**
   * Initialize the connection pool by opening all connections.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      throw new Error("Pool already initialized");
    }

    const errors: Error[] = [];
    const actualDbPath = urlToDbPath(this.dbPath);

    for (let i = 0; i < this.poolSize; i++) {
      try {
        // Open in read-only mode
        const db = new Database(actualDbPath, {
          create: false,
          readonly: true,
        });
        db.exec(READ_PRAGMAS);

        this.connections.push({
          db,
          inUse: false,
          preparedStatements: {},
        });
      } catch (error) {
        errors.push(error as Error);
        console.error(`Failed to open pool connection ${i}:`, error);
      }
    }

    if (this.connections.length === 0) {
      throw new AggregateError(
        errors,
        `Failed to open any pool connections for ${this.dbPath}`,
      );
    }

    if (errors.length > 0) {
      console.warn(
        `Pool initialized with ${this.connections.length}/${this.poolSize} connections`,
      );
    }

    this.initialized = true;
  }

  /**
   * Acquire a connection from the pool using round-robin allocation.
   * Returns the next available connection, or reuses one if all are busy
   * (SQLite WAL allows concurrent reads).
   */
  acquire(): PooledConnection {
    if (!this.initialized || this.connections.length === 0) {
      throw new Error("Pool not initialized");
    }

    // Try to find a free connection starting from round-robin index
    const startIndex = this.roundRobinIndex;
    do {
      const conn = this.connections[this.roundRobinIndex];
      this.roundRobinIndex =
        (this.roundRobinIndex + 1) % this.connections.length;

      if (!conn.inUse) {
        conn.inUse = true;
        return conn;
      }
    } while (this.roundRobinIndex !== startIndex);

    // All connections in use - just return the next one anyway
    // SQLite WAL mode handles concurrent reads safely
    const conn = this.connections[this.roundRobinIndex];
    this.roundRobinIndex =
      (this.roundRobinIndex + 1) % this.connections.length;
    return conn;
  }

  /**
   * Release a connection back to the pool.
   */
  release(conn: PooledConnection): void {
    conn.inUse = false;
  }

  /**
   * Get or create a prepared statement for a connection.
   */
  getPreparedStatement(
    conn: PooledConnection,
    key: PreparedStatementKey,
    sql: string,
  ): Statement {
    let stmt = conn.preparedStatements[key];
    if (!stmt) {
      stmt = conn.db.prepare(sql);
      conn.preparedStatements[key] = stmt;
    }
    return stmt;
  }

  /**
   * Close all connections and cleanup.
   */
  close(): void {
    for (const conn of this.connections) {
      // Finalize prepared statements
      for (const stmt of Object.values(conn.preparedStatements)) {
        if (stmt) {
          try {
            stmt.finalize();
          } catch {
            // Ignore finalization errors
          }
        }
      }

      // Close database
      try {
        conn.db.close();
      } catch {
        // Ignore close errors
      }
    }

    this.connections = [];
    this.initialized = false;
  }

  /**
   * Get the number of active connections in the pool.
   */
  get size(): number {
    return this.connections.length;
  }

  /**
   * Check if the pool is initialized.
   */
  get isInitialized(): boolean {
    return this.initialized;
  }
}
