# Cache-Level Interning Migration Plan

## Overview

This document describes the plan to move Merkle interning from the scheduler level to the cache layer (Nursery/Heap) for improved performance and architectural clarity.

## Current State (Scheduler-Level Interning)

### How It Works Now

Currently, interning happens at the **scheduler level** when storage notifications arrive:

```typescript
// In scheduler.ts:466-480
const spaceAndURI = `${space}/${change.address.id}` as SpaceAndURI;

// IMPORTANT: Always update internedStates for ALL entities, not just those with subscribers.
// This ensures that when a subscription is later created for an entity, we have the
// correct baseline state. Without this, the first notification after subscribing would
// see undefined as oldState, causing spurious triggers.
const oldState = this.internedStates.get(spaceAndURI);
const newState = change.after !== undefined ? internStringify(change.after) : undefined;

// Cache the new interned state for next notification
if (newState !== undefined) {
  this.internedStates.set(spaceAndURI, newState);
} else {
  // Entity deleted - remove from cache
  this.internedStates.delete(spaceAndURI);
}
```

### Data Flow

```
SQLite → Parse → Memory → Raw notification → Scheduler interns → SubscriptionTrie
                                                     ↓
                                          internedStates cache
```

The scheduler maintains a `Map<SpaceAndURI, any>` cache where:
- **Key**: `${space}/${entityId}` (e.g., `"did:key:abc/item123"`)
- **Value**: Interned state object with `INTERN_ID` symbol attached

### Key Implementation Details

1. **Interning Function Used**: `internStringify()` from `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/interning.ts`
   - This does `JSON.parse(JSON.stringify(value), internReviver)`
   - The `internReviver` performs bottom-up interning during parsing
   - Each object/array gets a `INTERN_ID` symbol (local, not global)

2. **Why ALL Entities Must Be Cached**:
   - Even entities without active subscribers must be cached
   - Otherwise, when a subscription is created later, `oldState` would be `undefined`
   - This causes spurious re-triggers since `undefined !== actualState`
   - Comment at scheduler.ts:467 explicitly warns about this

3. **Cache Characteristics**:
   - `INTERN_ID` is a local Symbol (`Symbol("intern-id")`) - not global
   - `valueCache` has `MAX_CACHE_SIZE = 1,000,000` entries
   - `stringCache` has `MAX_STRING_CACHE_SIZE = 10,000` entries
   - LRU eviction when limits are reached

### Current Interning Call Sites

| Location | Function | Count | Purpose |
|----------|----------|-------|---------|
| `memory/space.ts` | `internParse` | ~4 | Parse JSON from SQLite |
| `runner/scheduler.ts` | `internStringify` | 1 | Intern notifications |
| `runner/data-updating.ts` | `internNode` | 2 | Core Merkle algorithm |
| `runner/cell.ts` | `internStringify` | 1 | Cell value operations |
| `runner/attestation.ts` | `internParse` | 1 | Attestation metadata |
| `memory/consumer.ts` | `internStringify` | 1 | Transaction metadata |

## The Goal: Cache-Level Interning

Move interning into the **cache layer** so that all values are interned when they enter the cache, not when notifications are processed.

### Benefits

1. **Write Performance Improvement**:
   - When updating `{items: [...existing, newItem]}`:
   - Existing items already have cached `INTERN_ID`
   - `internNode` only hashes the delta, not the full structure
   - Result: **O(delta) instead of O(n)** for incremental updates

2. **Fewer Call Sites**:
   - Remove `internStringify` from scheduler.ts
   - Simplify or remove `internParse` from memory/space.ts
   - Single source of truth for interned values

3. **Architectural Clarity**:
   - Cache layer owns interning
   - Scheduler receives already-interned values
   - No need to intern on every notification

## Key Files to Modify

### 1. `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/storage/cache.ts`

**Nursery.put()** - Intern local writes:
```typescript
// Current (line 165):
static put(_before?: State, after?: State) {
  return after;
}

// Proposed:
static put(_before?: State, after?: State) {
  return after !== undefined ? internValue(after) : after;
}
```

**Heap.merge()** - Ensure all stored values are interned:
```typescript
// Current (line 224-254):
merge(
  entries: Iterable<Revision<State>>,
  merge: Merge<Revision<State>>,
  notifyFilter?: (state: Revision<State> | undefined) => boolean,
) {
  const updated = new Set<string>();
  for (const entry of entries) {
    const address = { id: entry.of, type: entry.the };
    const key = toKey(address);
    const stored = this.store.get(key);
    const merged = merge(stored, entry);
    if (merged === undefined) {
      this.store.delete(key);
      updated.add(key);
    } else if (stored !== merged) {
      this.store.set(key, merged);  // <-- Should intern here
      updated.add(key);
    }
  }
  // ... notify subscribers
}

// Proposed: Intern before storing
if (merged === undefined) {
  this.store.delete(key);
  updated.add(key);
} else if (stored !== merged) {
  const interned = internValue(merged);  // <-- Add interning
  this.store.set(key, interned);
  updated.add(key);
}
```

### 2. `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/scheduler.ts`

**Remove interning from createStorageSubscription()**:
```typescript
// Current (line 471-472):
const oldState = this.internedStates.get(spaceAndURI);
const newState = change.after !== undefined ? internStringify(change.after) : undefined;

// Proposed:
const oldState = this.internedStates.get(spaceAndURI);
const newState = change.after;  // Already interned by cache!
```

**Keep the internedStates cache** - Still needed to track `oldState` vs `newState` for subscriptions, but no longer needs to perform interning.

### 3. `/home/wkelly/src/commontoolsinc/labs/packages/memory/space.ts`

Currently uses `internParse()` in ~4 places when reading from SQLite. After cache-level interning:
- Either delegate to cache.ts to intern after parsing
- Or keep local interning but ensure cache also interns (double-interning is O(1) due to INTERN_ID check)

### 4. `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/cell.ts`

May need to update Cell.setRaw() to use cache or keep local interning for consistency.

## Data Flow Comparison

### Current (Scheduler-Level)
```
┌──────────┐
│  SQLite  │
└────┬─────┘
     │ internParse (space.ts)
     ▼
┌──────────┐
│  Memory  │
└────┬─────┘
     │ Raw notification (not interned)
     ▼
┌──────────────────┐
│    Scheduler     │
│  internStringify │  ◄── INTERNING HAPPENS HERE
└────┬─────────────┘
     │ cache.after → internedStates
     ▼
┌──────────────────┐
│ SubscriptionTrie │
│  trie.notify()   │
└──────────────────┘
```

### Proposed (Cache-Level)
```
┌──────────┐
│  SQLite  │
└────┬─────┘
     │ Parse (no interning yet)
     ▼
┌──────────────────┐
│  Cache Layer     │
│  Nursery.put()   │  ◄── INTERNING HAPPENS HERE
│  Heap.merge()    │
└────┬─────────────┘
     │ Interned notification
     ▼
┌──────────────────┐
│    Scheduler     │
│  (no interning)  │
└────┬─────────────┘
     │ already interned
     ▼
┌──────────────────┐
│ SubscriptionTrie │
│  trie.notify()   │
└──────────────────┘
```

## Implementation Steps

### Phase 1: Add Interning to Cache Layer
1. Import `internValue` (or create wrapper around `internStringify`)
2. Modify `Nursery.put()` to intern `after` parameter
3. Modify `Heap.merge()` to intern merged values before storing
4. Add tests to verify interning happens (check for `INTERN_ID` symbol)

### Phase 2: Verify Data Flow
1. Ensure values from SQLite flow through cache before reaching scheduler
2. Verify `change.after` in notifications is already interned
3. Add assertions/logging to confirm INTERN_ID is present

### Phase 3: Remove Scheduler Interning
1. Remove `internStringify` call from scheduler.ts:472
2. Update comment to reflect that values are already interned
3. Keep `internedStates` cache for oldState tracking

### Phase 4: Clean Up Other Call Sites
1. Review `internParse` usage in memory/space.ts
   - Option A: Remove if cache handles it
   - Option B: Keep for consistency (double-interning is cheap)
2. Update Cell.setRaw() if needed
3. Remove any redundant interning calls

### Phase 5: Performance Validation
1. Run benchmarks before/after to verify performance improvement
2. Measure write performance for incremental updates
3. Check that structural sharing is preserved

## Testing Strategy

### Unit Tests
1. **Cache interning**: Verify Nursery.put() and Heap.merge() return interned values
2. **INTERN_ID presence**: Check that cached values have INTERN_ID symbol
3. **Structural sharing**: Verify identical subtrees share references

### Integration Tests
1. **End-to-end flow**: Write → Cache → Notification → Scheduler → Trie
2. **Subscription re-triggers**: Ensure no spurious triggers
3. **Incremental updates**: Verify O(delta) performance for array appends

### Benchmarks
1. **Before/after comparison**: Measure write performance improvement
2. **Large updates**: Test with documents containing 1000+ items
3. **Memory usage**: Verify cache size remains bounded

## Important Considerations

### 1. Symbol Locality
- `INTERN_ID = Symbol("intern-id")` is **local to interning.ts**
- Not a global symbol - cannot be accessed from other modules directly
- Only check via `isInterned(value)` or by importing INTERN_ID

### 2. Cache Coherence
- **Critical**: ALL code paths that put values into cache MUST intern
- Missing interning in one path breaks structural sharing
- Consider adding a validation layer/assertion

### 3. Backward Compatibility
- Existing code expects `change.after` in notifications
- Interned values are still valid JSON-serializable objects
- Symbol is non-enumerable, won't appear in JSON.stringify()

### 4. Double-Interning is Safe
- If value already has INTERN_ID, interning is O(1) (cache hit)
- Safe to call internStringify() multiple times
- Can keep defensive interning at multiple layers if needed

### 5. Notification Timing
- Scheduler must update `internedStates` for ALL entities
- Even entities without active subscribers
- This ensures correct oldState when subscriptions are created later

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Missing interning in a code path | Breaks structural sharing | Add validation/assertions |
| INTERN_ID not propagated | Cache misses increase | Test INTERN_ID presence |
| Memory leak in cache | Unbounded growth | LRU eviction already in place |
| Performance regression | Slower writes | Benchmark before/after |
| Notification race conditions | Spurious triggers | Preserve ALL entities in cache |

## Success Criteria

1. ✅ All values in Heap/Nursery have INTERN_ID
2. ✅ Scheduler receives interned values in notifications
3. ✅ No change in functional behavior (all tests pass)
4. ✅ Write performance improves for incremental updates
5. ✅ Code is simpler (fewer interning call sites)

## Future Optimizations

Once cache-level interning is stable, consider:

1. **Persistent INTERN_ID**: Store intern IDs in SQLite for cold starts
2. **Selective interning**: Skip interning for small/transient values
3. **Incremental hashing**: Use Merkle tree properties for faster updates
4. **Cross-space sharing**: Share interned values across memory spaces

## References

- Phase 5 of plan: `/home/wkelly/.claude/plans/concurrent-whistling-castle.md` (lines 235-336)
- Scheduler implementation: `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/scheduler.ts`
- Cache implementation: `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/storage/cache.ts`
- Interning implementation: `/home/wkelly/src/commontoolsinc/labs/packages/runner/src/interning.ts`
- Memory/space implementation: `/home/wkelly/src/commontoolsinc/labs/packages/memory/space.ts`

## Related Debugging Context

From recent debugging sessions:

1. **INTERN_ID is local**: Cannot access from outside interning.ts without importing
2. **ALL entities must be cached**: Not just those with subscribers (scheduler.ts:467 comment)
3. **Cache sizes**: valueCache=1M entries, stringCache=10K entries
4. **Double-interning is safe**: O(1) cache hit if already interned
5. **Symbol is non-enumerable**: Won't break JSON serialization

---

**Status**: Planning stage. Not yet implemented.
**Owner**: To be assigned
**Last Updated**: 2025-12-07
