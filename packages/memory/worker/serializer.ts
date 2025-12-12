/**
 * Zero-copy serialization for Selection results.
 * Enables efficient transfer of large query results between worker and main thread.
 *
 * Binary Format:
 * - Header: 4 bytes (entry count, little-endian uint32)
 * - For each entry:
 *   - space length: 2 bytes (uint16)
 *   - space: variable bytes (UTF-8)
 *   - of length: 2 bytes (uint16)
 *   - of: variable bytes (UTF-8)
 *   - the length: 2 bytes (uint16)
 *   - the: variable bytes (UTF-8)
 *   - cause length: 2 bytes (uint16)
 *   - cause: variable bytes (UTF-8)
 *   - value length: 4 bytes (uint32)
 *   - value: variable bytes (JSON UTF-8)
 */

import type { FactSelection, Selection } from "../interface.ts";

const HEADER_SIZE = 4;
const LEN_SIZE_16 = 2;
const LEN_SIZE_32 = 4;

// Threshold for using binary transfer vs structured clone
export const BINARY_THRESHOLD_BYTES = 64 * 1024; // 64KB

/**
 * Estimate the serialized size of a Selection to decide transfer method.
 */
export function estimateSelectionSize(selection: Selection): number {
  // Quick estimate using JSON string length
  try {
    return JSON.stringify(selection).length;
  } catch {
    return 0;
  }
}

/**
 * Check if binary transfer should be used based on estimated size.
 */
export function shouldUseBinaryTransfer(selection: Selection): boolean {
  return estimateSelectionSize(selection) > BINARY_THRESHOLD_BYTES;
}

interface SelectionEntry {
  space: string;
  of: string;
  the: string;
  cause: string;
  value: string; // JSON stringified
}

/**
 * Flatten a Selection into an array of entries for serialization.
 */
function flattenSelection(selection: Selection): SelectionEntry[] {
  const entries: SelectionEntry[] = [];

  for (const [space, factSelection] of Object.entries(selection)) {
    if (!factSelection || typeof factSelection !== "object") continue;

    for (const [of, types] of Object.entries(factSelection)) {
      if (!types || typeof types !== "object") continue;

      for (const [the, causes] of Object.entries(types)) {
        if (!causes || typeof causes !== "object") continue;

        for (const [cause, value] of Object.entries(causes)) {
          entries.push({
            space,
            of,
            the,
            cause,
            value: JSON.stringify(value),
          });
        }
      }
    }
  }

  return entries;
}

/**
 * Calculate the total buffer size needed for the entries.
 */
function calculateBufferSize(entries: SelectionEntry[]): number {
  const encoder = new TextEncoder();
  let size = HEADER_SIZE;

  for (const entry of entries) {
    // Each field: 2-byte length + content
    size += LEN_SIZE_16 + encoder.encode(entry.space).length;
    size += LEN_SIZE_16 + encoder.encode(entry.of).length;
    size += LEN_SIZE_16 + encoder.encode(entry.the).length;
    size += LEN_SIZE_16 + encoder.encode(entry.cause).length;
    // Value uses 4-byte length for larger JSON strings
    size += LEN_SIZE_32 + encoder.encode(entry.value).length;
  }

  return size;
}

/**
 * Serialize a Selection to an ArrayBuffer for zero-copy transfer.
 */
export function serializeSelection(selection: Selection): ArrayBuffer {
  const entries = flattenSelection(selection);
  const totalSize = calculateBufferSize(entries);

  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const encoder = new TextEncoder();

  // Write header: entry count
  view.setUint32(0, entries.length, true);

  let offset = HEADER_SIZE;

  for (const entry of entries) {
    // Write space
    const spaceBytes = encoder.encode(entry.space);
    view.setUint16(offset, spaceBytes.length, true);
    offset += LEN_SIZE_16;
    new Uint8Array(buffer, offset, spaceBytes.length).set(spaceBytes);
    offset += spaceBytes.length;

    // Write of
    const ofBytes = encoder.encode(entry.of);
    view.setUint16(offset, ofBytes.length, true);
    offset += LEN_SIZE_16;
    new Uint8Array(buffer, offset, ofBytes.length).set(ofBytes);
    offset += ofBytes.length;

    // Write the
    const theBytes = encoder.encode(entry.the);
    view.setUint16(offset, theBytes.length, true);
    offset += LEN_SIZE_16;
    new Uint8Array(buffer, offset, theBytes.length).set(theBytes);
    offset += theBytes.length;

    // Write cause
    const causeBytes = encoder.encode(entry.cause);
    view.setUint16(offset, causeBytes.length, true);
    offset += LEN_SIZE_16;
    new Uint8Array(buffer, offset, causeBytes.length).set(causeBytes);
    offset += causeBytes.length;

    // Write value (JSON)
    const valueBytes = encoder.encode(entry.value);
    view.setUint32(offset, valueBytes.length, true);
    offset += LEN_SIZE_32;
    new Uint8Array(buffer, offset, valueBytes.length).set(valueBytes);
    offset += valueBytes.length;
  }

  return buffer;
}

/**
 * Deserialize an ArrayBuffer back to a Selection.
 */
export function deserializeSelection(buffer: ArrayBuffer): Selection {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();

  const entryCount = view.getUint32(0, true);
  const selection: Selection = {} as Selection;

  let offset = HEADER_SIZE;

  for (let i = 0; i < entryCount; i++) {
    // Read space
    const spaceLen = view.getUint16(offset, true);
    offset += LEN_SIZE_16;
    const space = decoder.decode(new Uint8Array(buffer, offset, spaceLen));
    offset += spaceLen;

    // Read of
    const ofLen = view.getUint16(offset, true);
    offset += LEN_SIZE_16;
    const of = decoder.decode(new Uint8Array(buffer, offset, ofLen));
    offset += ofLen;

    // Read the
    const theLen = view.getUint16(offset, true);
    offset += LEN_SIZE_16;
    const the = decoder.decode(new Uint8Array(buffer, offset, theLen));
    offset += theLen;

    // Read cause
    const causeLen = view.getUint16(offset, true);
    offset += LEN_SIZE_16;
    const cause = decoder.decode(new Uint8Array(buffer, offset, causeLen));
    offset += causeLen;

    // Read value (JSON)
    const valueLen = view.getUint32(offset, true);
    offset += LEN_SIZE_32;
    const valueJson = decoder.decode(new Uint8Array(buffer, offset, valueLen));
    offset += valueLen;

    const value = JSON.parse(valueJson);

    // Reconstruct nested structure using type-safe casting
    const selectionRecord = selection as unknown as Record<string, FactSelection>;
    if (!selectionRecord[space]) {
      selectionRecord[space] = {};
    }
    const factSelection = selectionRecord[space] as Record<string, Record<string, Record<string, unknown>>>;

    if (!factSelection[of]) {
      factSelection[of] = {};
    }
    if (!factSelection[of][the]) {
      factSelection[of][the] = {};
    }
    factSelection[of][the][cause] = value;
  }

  return selection;
}
