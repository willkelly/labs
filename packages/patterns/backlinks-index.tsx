/// <cts-enable />
import { Cell, derive, lift, NAME, OpaqueRef, recipe, UI } from "commontools";

export type MentionableCharm = {
  [NAME]?: string;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
};

export type WriteableBacklinks = {
  mentioned: WriteableBacklinks[];
  backlinks: Cell<WriteableBacklinks[]>;
};

type Input = {
  allCharms: MentionableCharm[];
};

type Output = {
  mentionable: MentionableCharm[];
};

const computeIndex = lift<
  { allCharms: WriteableBacklinks[] },
  void
>(
  ({ allCharms }) => {
    const cs = allCharms ?? [];

    // Build the complete desired backlinks state for each charm FIRST,
    // then set once. This avoids the clear-then-rebuild pattern that
    // causes spurious writes and transaction conflicts.
    const desiredBacklinks = new Map<WriteableBacklinks, WriteableBacklinks[]>();

    // Initialize all charms with empty backlinks
    for (const c of cs) {
      if (c.backlinks) {
        desiredBacklinks.set(c, []);
      }
    }

    // Compute desired backlinks from mentions
    for (const c of cs) {
      const mentions = c.mentioned ?? [];
      for (const m of mentions) {
        if (m) {
          const list = desiredBacklinks.get(m);
          if (list) {
            list.push(c);
          }
        }
      }
    }

    // Set final state for each charm.
    // Sort by JSON representation (which is the Merkle hash for Cell references)
    // to ensure deterministic order across clients. This enables the idempotency
    // check in Cell.set() to detect identical content regardless of iteration order.
    for (const [charm, backlinks] of desiredBacklinks) {
      backlinks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      charm.backlinks?.set(backlinks);
    }
  },
);

/**
 * BacklinksIndex builds a map of backlinks across all charms and exposes a
 * unified mentionable list for consumers like editors.
 *
 * Behavior:
 * - Backlinks are computed by scanning each charm's `mentioned` list and
 *   mapping mention target -> list of source charms.
 * - Mentionable list is a union of:
 *   - every charm in `allCharms`
 *   - any items a charm exports via a `mentionable` property
 *     (either an array of charms or a Cell of such an array)
 *
 * The backlinks map is keyed by a charm's `content` value (falling back to
 * its `[NAME]`). This mirrors how existing note patterns identify notes when
 * computing backlinks locally.
 */
const BacklinksIndex = recipe<Input, Output>(
  "BacklinksIndex",
  ({ allCharms }) => {
    computeIndex({
      allCharms: allCharms as unknown as OpaqueRef<WriteableBacklinks[]>,
    });

    // Compute mentionable list from allCharms reactively
    const mentionable = derive(allCharms, (charmList) => {
      const cs = charmList ?? [];
      const out: MentionableCharm[] = [];
      for (const c of cs) {
        out.push(c);
        const exported = (c as unknown as {
          mentionable?: MentionableCharm[] | { get?: () => MentionableCharm[] };
        }).mentionable;
        if (Array.isArray(exported)) {
          for (const m of exported) if (m) out.push(m);
        } else if (exported && typeof (exported as any).get === "function") {
          const arr = (exported as { get: () => MentionableCharm[] }).get() ??
            [];
          for (const m of arr) if (m) out.push(m);
        }
      }
      return out;
    });

    return {
      [NAME]: "BacklinksIndex",
      [UI]: undefined,
      mentionable,
    };
  },
);

export default BacklinksIndex;
