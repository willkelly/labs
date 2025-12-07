import { refer } from "merkle-reference/json";

const valueCache = new Map<string, any>();
const stringCache = new Map<string, any>(); // Cache by hashed JSON string to avoid re-parsing
const MAX_CACHE_SIZE = 50000;
const MAX_STRING_CACHE_SIZE = 10000;
const INTERN_ID = Symbol("intern-id");

/**
 * Recursively freezes an object and all nested objects/arrays.
 * This enforces runtime immutability for interned values.
 *
 * @param obj - The object to freeze
 * @returns The same object, now deeply frozen
 */
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Object.isFrozen(obj)) {
    return obj;
  }

  Object.freeze(obj);

  if (Array.isArray(obj)) {
    for (const item of obj) {
      deepFreeze(item);
    }
  } else {
    for (const value of Object.values(obj)) {
      deepFreeze(value);
    }
  }

  return obj;
}

/**
 * JSON.parse reviver that interns objects based on structural (Merkle-like) identity.
 * 
 * Strategy:
 * 1. Parse bottom-up (standard JSON.parse behavior).
 * 2. For each object/array, construct a "Shallow Key" representing its immediate content.
 *    - Primitives are stringified.
 *    - Child Objects/Arrays are replaced by their *already computed* Deterministic ID.
 * 3. This "Shallow Key" effectively acts as the content of a Merkle DAG node.
 * 4. The object's Deterministic ID is computed from this Shallow Key.
 *    - Small keys are used as-is for readability and zero-collision.
 *    - Large keys are hashed using the standard `merkle-reference` library.
 * 5. We cache based on this ID.
 * 
 * Benefits:
 * - Deterministic: Identical structures get identical object references.
 * - Memory Efficient: Parent keys only contain short Child IDs, not full subtrees.
 * - Standardized: Uses project-standard hashing.
 */
function internReviver(key: string, value: any): any {
  if (typeof value === 'object' && value !== null) {
    // Optimization: If this specific object instance was already processed, return it.
    if ((value as any)[INTERN_ID]) return value;

    let shallowKey = "";
    
    // Construct the Shallow Key (Merkle Node Content)
    if (Array.isArray(value)) {
      shallowKey = '[';
      for (let i = 0; i < value.length; i++) {
        if (i > 0) shallowKey += ',';
        const item = value[i];
        // If child is an object, it must have been processed already (bottom-up).
        // Use its ID.
        if (item && typeof item === 'object') {
           const childId = (item as any)[INTERN_ID];
           if (childId !== undefined) {
             shallowKey += childId;
           } else {
             // Fallback for safety, though theoretically shouldn't happen in pure JSON.parse flow
             shallowKey += JSON.stringify(item);
           }
        } else {
           // Primitives
           shallowKey += JSON.stringify(item);
        }
      }
      shallowKey += ']';
    } else {
      // Object: Sort keys for canonical representation
      const sortedKeys = Object.keys(value).sort();
      shallowKey = '{';
      for (let i = 0; i < sortedKeys.length; i++) {
        const k = sortedKeys[i];
        if (i > 0) shallowKey += ',';
        shallowKey += JSON.stringify(k);
        shallowKey += ':';
        const item = value[k];
        
        if (item && typeof item === 'object') {
           const childId = (item as any)[INTERN_ID];
           if (childId !== undefined) {
             shallowKey += childId;
           } else {
             shallowKey += JSON.stringify(item);
           }
        } else {
           shallowKey += JSON.stringify(item);
        }
      }
      shallowKey += '}';
    }

    // Compute Deterministic ID (Cache Key)
    let id: string;
    // Threshold for using raw content as ID. 
    // 64 chars seems reasonable (roughly length of a CID).
    if (shallowKey.length < 64) {
      id = shallowKey;
    } else {
      // Use standard Merkle hash for larger nodes
      id = refer(shallowKey).toString();
    }

    // Check Cache (Deduplication)
    const cached = valueCache.get(id);
    if (cached) {
      return cached;
    }

    // Cache Miss: Prepare new entry
    // 1. Cache Eviction (LRU-ish)
    if (valueCache.size >= MAX_CACHE_SIZE) {
      const firstKey = valueCache.keys().next().value;
      if (firstKey) {
        valueCache.delete(firstKey);
      }
    }
    
    // 2. Store Metadata
    Object.defineProperty(value, INTERN_ID, { value: id, enumerable: false, writable: true });

    // 3. Deep freeze for immutability enforcement
    deepFreeze(value);

    // 4. Store in Cache
    valueCache.set(id, value);

    return value;
  }

  return value;
}

/**
 * Parse a JSON string and return an interned, frozen object.
 * Identical JSON structures will return the same object reference.
 *
 * Uses a string-based cache to avoid re-parsing the same JSON string,
 * plus a value-based cache for structural deduplication.
 *
 * @param jsonString - The JSON string to parse
 * @returns A frozen, interned object
 */
export function internParse(jsonString: string): any {
  // Fast path: check if we've already parsed this exact string
  // Use SHA-256 hash (via refer) as key - collision resistant and avoids storing large strings
  const cacheKey = refer(jsonString).toString();
  const cached = stringCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  // Parse with interning reviver
  const result = JSON.parse(jsonString, internReviver);

  // Cache by hashed string for future calls with same JSON
  // LRU eviction for string cache
  if (stringCache.size >= MAX_STRING_CACHE_SIZE) {
    const firstKey = stringCache.keys().next().value;
    if (firstKey) {
      stringCache.delete(firstKey);
    }
  }
  stringCache.set(cacheKey, result);

  return result;
}

/**
 * Serialize a value to JSON and then parse it back through interning.
 * This validates JSON serializability and returns a frozen, interned object.
 *
 * Use this instead of JSON.parse(JSON.stringify(value)) to get structural sharing.
 *
 * @param value - The value to serialize and intern
 * @returns A frozen, interned copy of the value
 */
export function internStringify<T>(value: T): T {
  const json = JSON.stringify(value);
  return internParse(json) as T;
}

/**
 * Check if a value has been interned.
 *
 * @param value - The value to check
 * @returns true if the value has an INTERN_ID symbol
 */
export function isInterned(value: unknown): boolean {
  return typeof value === "object" && value !== null && INTERN_ID in value;
}

/**
 * Clear the intern cache. Useful for testing.
 */
export function clearInternCache(): void {
  valueCache.clear();
  stringCache.clear();
}