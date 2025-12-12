/**
 * Worker IPC protocol for the read worker pool.
 * Defines message types for communication between main thread and read workers.
 */

import type {
  MemorySpace,
  Query,
  QueryArgs,
  SchemaQuery,
  SchemaQueryArgs,
  Selection,
} from "../interface.ts";

// Message types for worker communication
export enum MessageType {
  Init = "init",
  Query = "query",
  QuerySchema = "querySchema",
  Close = "close",
}

// Request message sent from main thread to initialize worker
export interface InitMessage {
  type: MessageType.Init;
  msgId: number;
  spaceUrl: string; // SQLite file URL
  subject: string; // Space subject identifier
  poolSize: number; // Number of connections (default 10)
}

// Request message for query operation
export interface QueryMessage {
  type: MessageType.Query;
  msgId: number;
  args: QueryArgs;
}

// Request message for schema query operation
export interface QuerySchemaMessage {
  type: MessageType.QuerySchema;
  msgId: number;
  args: SchemaQueryArgs;
}

// Request message to close worker and cleanup
export interface CloseMessage {
  type: MessageType.Close;
  msgId: number;
}

// Union of all request types
export type WorkerRequest =
  | InitMessage
  | QueryMessage
  | QuerySchemaMessage
  | CloseMessage;

// Successful response with optional binary transfer
export interface SuccessResponse<T = unknown> {
  msgId: number;
  ok: true;
  // For large results: zero-copy binary transfer
  resultBuffer?: ArrayBuffer;
  // For small results: structured clone
  result?: T;
}

// Error response
export interface ErrorResponse {
  msgId: number;
  ok: false;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}

// Union of all response types
export type WorkerResponse<T = unknown> = SuccessResponse<T> | ErrorResponse;

// Ready signal sent when worker is loaded
export interface ReadyMessage {
  type: "ready";
  msgId: -1;
}

// Type guard for worker requests
export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return (
    typeof msg.msgId === "number" &&
    typeof msg.type === "string" &&
    Object.values(MessageType).includes(msg.type as MessageType)
  );
}

// Type guard for worker responses
export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return typeof msg.msgId === "number" && typeof msg.ok === "boolean";
}

// Type guard for ready message
export function isReadyMessage(value: unknown): value is ReadyMessage {
  if (typeof value !== "object" || value === null) return false;
  const msg = value as Record<string, unknown>;
  return msg.type === "ready" && msg.msgId === -1;
}

// Helper to create error response from caught error
export function createErrorResponse(
  msgId: number,
  error: unknown,
): ErrorResponse {
  const err = error instanceof Error ? error : new Error(String(error));
  return {
    msgId,
    ok: false,
    error: {
      name: err.name ?? "Error",
      message: err.message ?? String(error),
      stack: err.stack,
    },
  };
}
