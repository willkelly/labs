# Idempotency, Content-Based Addressing, and Identity

This document captures learnings from debugging transaction conflict storms and implementing idempotent writes in the Common Tools runtime.

## The Problem: Transaction Conflict Storms

When multiple clients (e.g., two browser tabs with launchers) observe the same data and react to changes, they can enter conflict storms:

1. Client A and B both read `allCharms`
2. Both run BacklinksIndex which writes to each charm's backlinks
3. Both try to write to the same entities simultaneously
4. Optimistic concurrency causes ConflictError
5. Both retry, conflict again, creating a storm

### Symptoms
- High CPU usage
- Many requests to toolshed
- Repeated ConflictError in logs with messages like "was expected to be ba4jcb..., but now it is ba4jca..."

## The Solution: Idempotent Writes

We implemented idempotency checks at two levels:

### 1. Cell.set() Idempotency (`cell.ts`)

```typescript
// Before writing, compare interned representations
const currentInterned = internStringify(currentValue);
const newInterned = internStringify(transformedValue);
if (currentInterned === newInterned) {
  // Skip write - value unchanged
  return this;
}
```

### 2. diffAndUpdate() Idempotency (`data-updating.ts`)

```typescript
// Early check before expensive normalization
const currentInterned = internStringify(currentValue);
const newInterned = internStringify(newValue);
if (currentInterned === newInterned) {
  return false; // No changes
}
```

### 3. Deterministic Ordering (`backlinks-index.tsx`)

Multiple clients iterating the same data in different orders would produce different array orderings. We sort before writing:

```typescript
backlinks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
charm.backlinks?.set(backlinks);
```

## Content-Based Addressing: A Paradigm Shift

We've moved to **content-based addressing** throughout the system. This means:

> **Same content = Same ID**

This is similar to how Git or IPFS work - content is hashed to produce a deterministic identifier.

### Benefits
- Merkle interning: identical subtrees share storage
- O(1) change detection via reference equality
- Automatic deduplication
- Deterministic entity IDs across clients

### The Clojure Atoms Model

Think of it like Clojure's approach:
- **Content layer**: Pure data, content-addressed (same content = same hash)
- **Identity layer**: Cells provide stable identity that can wrap content

When you need distinct identity for identical content, wrap it in a Cell or use an explicit ID.

## Impact on Patterns

### Patterns That Need Updates

With content-based IDs, **adding the same content twice produces the same entity**. This breaks patterns that expect distinct items with identical content.

| Pattern | Issue | Fix |
|---------|-------|-----|
| `todo-list.tsx` | Two todos with same title merge | Add `[ID]: randomId` |
| `chatbot-outliner.tsx` | Same body text merges nodes | Add `[ID]: randomId` |
| `common-tools.tsx` | Same item title merges | Add `[ID]: randomId` |
| `array-in-cell-*.tsx` | Same message merges | Add `[ID]: randomId` |

### Patterns Already Correct

| Pattern | Why It Works |
|---------|--------------|
| `chatbot-list-view.tsx` | Uses `[ID]: randomId` explicitly |
| `voice-note.tsx` | TranscriptionData has unique `id` field |
| `backlinks-index.tsx` | Pushes charm references (have identity) |

### How to Fix Affected Patterns

```typescript
import { ID } from "commontools";

// BEFORE: Same content = same entity (broken for duplicates)
items.push({ title: "Buy milk", done: false });
items.push({ title: "Buy milk", done: false }); // Merges with first!

// AFTER: Explicit identity for distinct items
const randomId = Math.random().toString(36).substring(2, 10);
items.push({ [ID]: randomId, title: "Buy milk", done: false });
```

The `[ID]` field tells the system "this is the identity key" rather than deriving identity from content.

### When to Use Explicit IDs

Use explicit `[ID]` when:
- Users can create multiple items with identical content (todos, notes, list items)
- Items need to be individually addressable/deletable
- Order matters and duplicates are valid

You DON'T need explicit IDs when:
- Content is naturally unique (timestamps, UUIDs already in data)
- Deduplication is desired (tags, categories, references)
- Items are references to Cells (which already have identity)

## Testing Idempotency

See `test/idempotency.test.ts` for comprehensive tests covering:
- Cell.set() skipping writes for unchanged values
- diffAndUpdate() early exit for unchanged values
- Sorted arrays producing consistent interned values
- Scheduler not re-triggering actions on idempotent writes
- BacklinksIndex-like patterns with recomputation

## Key Files Changed

- `packages/runner/src/cell.ts` - Idempotency check in `set()`
- `packages/runner/src/data-updating.ts` - Early idempotency check in `diffAndUpdate()`
- `packages/patterns/backlinks-index.tsx` - Sorted backlinks, compute-then-set pattern
- `packages/runner/test/idempotency.test.ts` - Test coverage

## Debugging Conflicts

If you see conflict storms:

1. Check if multiple instances are running the same reactive code
2. Look for patterns that do clear-then-rebuild (should compute-then-set)
3. Verify arrays are sorted before setting
4. Check if patterns need explicit `[ID]` fields for duplicate content
5. Enable scheduler logging to see notification counts
