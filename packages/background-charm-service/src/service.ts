import { Identity } from "@commontools/identity";
import { type Cell, type MemorySpace, type Runtime } from "@commontools/runner";
import {
  BG_CELL_CAUSE,
  BG_SYSTEM_SPACE_ID,
  type BGCharmEntry,
  LOCAL_BG_CELL_CAUSE,
  type RegistryMode,
} from "./schema.ts";
import { getBGCharms } from "./utils.ts";
import { SpaceManager } from "./space-manager.ts";
import { useCancelGroup } from "@commontools/runner";

export interface BackgroundCharmServiceOptions {
  identity: Identity;
  toolshedUrl: string;
  runtime: Runtime;
  bgSpace?: MemorySpace;
  bgCause?: string;
  workerTimeoutMs?: number;
  registryMode?: RegistryMode;
  targetSpaceDid?: MemorySpace; // Required when registryMode="local"
}

export class BackgroundCharmService {
  private charmsCell: Cell<Cell<BGCharmEntry>[]> | null = null;
  private isRunning = false;
  private charmSchedulers: Map<string, SpaceManager> = new Map();
  private identity: Identity;
  private toolshedUrl: string;
  private runtime: Runtime;
  private bgSpace: MemorySpace;
  private bgCause: string;
  private workerTimeoutMs?: number;
  private registryMode: RegistryMode;
  private targetSpaceDid?: MemorySpace;

  constructor(options: BackgroundCharmServiceOptions) {
    this.identity = options.identity;
    this.toolshedUrl = options.toolshedUrl;
    this.runtime = options.runtime;
    this.registryMode = options.registryMode ?? "central";
    this.targetSpaceDid = options.targetSpaceDid;
    this.bgSpace = options.bgSpace ?? BG_SYSTEM_SPACE_ID;
    this.bgCause = options.bgCause ??
      (this.registryMode === "local" ? LOCAL_BG_CELL_CAUSE : BG_CELL_CAUSE);
    this.workerTimeoutMs = options.workerTimeoutMs;
  }

  async initialize() {
    // Validate local mode requirements
    if (this.registryMode === "local" && !this.targetSpaceDid) {
      throw new Error("targetSpaceDid is required when registryMode is 'local'");
    }

    console.log(
      `Initializing BackgroundCharmService in ${this.registryMode} mode` +
        (this.registryMode === "local" ? ` for space ${this.targetSpaceDid}` : ""),
    );

    // Storage URL and signer are already configured in the Runtime
    this.charmsCell = await getBGCharms({
      bgSpace: this.registryMode === "local" ? this.targetSpaceDid : this.bgSpace,
      bgCause: this.bgCause,
      runtime: this.runtime,
      mode: this.registryMode,
      spaceId: this.registryMode === "local" ? this.targetSpaceDid : undefined,
    });
    await this.charmsCell.sync();
    await this.runtime.storageManager.synced();

    if (this.isRunning) {
      console.log("Service is already running");
      return;
    }

    this.isRunning = true;
    this.charmsCell.sink((cs) => this.ensureCharms(cs));
  }

  stop(): Promise<PromiseSettledResult<void>[]> {
    // FIXME(ja): stop listening to the charms cell ?
    if (!this.isRunning) {
      console.log("Service is not running");
      return Promise.resolve([]);
    }

    const promises = Array.from(this.charmSchedulers.values()).map(
      (scheduler) => scheduler.stop(),
    );
    return Promise.allSettled(promises);
  }

  // FIXME(ja): space managers should watch their own charms!
  // Note(ja): this assumes that sync won't return an empty
  // array / partial results!
  private ensureCharms(charms: readonly Cell<BGCharmEntry>[]) {
    if (!this.isRunning) {
      console.log("ignoring charms update because service asked to stop");
      return;
    }

    const [cancel, addCancel] = useCancelGroup();

    // In local mode, all charms are for our single target space
    if (this.registryMode === "local") {
      if (!this.charmSchedulers.has(this.targetSpaceDid!)) {
        const scheduler = new SpaceManager({
          did: this.targetSpaceDid!,
          toolshedUrl: this.toolshedUrl,
          identity: this.identity,
          timeoutMs: this.workerTimeoutMs,
        });
        this.charmSchedulers.set(this.targetSpaceDid!, scheduler);
        scheduler.start();
      }
      const scheduler = this.charmSchedulers.get(this.targetSpaceDid!)!;
      addCancel(scheduler.watch([...charms]));
      console.log(`[local mode] monitoring ${charms.length} charms for space ${this.targetSpaceDid}`);
      return cancel;
    }

    // Central mode - original multi-space logic
    // Charms that hit an e.g. Authorization Error are empty, and space
    // is undefined -- filter out any of these charms before creating
    // a worker
    const charmContents = charms.map((c) => c.get()).filter(Boolean);
    const enabledCharms = charmContents.filter((c) => !c.disabledAt);
    const dids = new Set(enabledCharms.map((c) => c.space));
    console.log(`[central mode] monitoring ${dids.size} spaces`);

    for (const did of dids) {
      let scheduler = this.charmSchedulers.get(did);
      if (!scheduler) {
        // Should send a derived/non-top-level key
        // to each space once delegation is working.
        scheduler = new SpaceManager({
          did,
          toolshedUrl: this.toolshedUrl,
          identity: this.identity,
          timeoutMs: this.workerTimeoutMs,
        });
        this.charmSchedulers.set(did, scheduler);
        scheduler.start();
      }

      // we are only filtering charms because until the FIXME above is fixed
      const didCharms = charms.filter((c) => c.get().space === did);
      addCancel(scheduler.watch(didCharms));
    }

    const removedSpaces = new Set(this.charmSchedulers.keys()).difference(dids);
    for (const did of removedSpaces.values()) {
      // we are no longer monitoring this space
      const scheduler = this.charmSchedulers.get(did);
      this.charmSchedulers.delete(did);
      // we can't await this in our callback, but we can at least catch and log errors
      scheduler?.stop().catch((e) =>
        console.error(`Error stopping scheduler: ${e}`)
      );
      // TODO(@ubik2) I'm not sure if we need to call the cancel function returned by scheduler.watch
    }

    return cancel;
  }
}
