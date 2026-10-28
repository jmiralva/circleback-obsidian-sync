// Saves the edits the settings tab makes, and works out at close which of them need a full sync.
// It is kept apart from the tab, which needs a DOM, so that the part that can lose a user's edit
// or show a wrong notice can be tested with fake timers.
//
// Two kinds of edit:
// - `commit`: a toggle or dropdown. Saved at once.
// - `later`: a text or number field. Saved once typing pauses, with every other edit that is
//   waiting, so typing does not write data.json on every key.
//
// Every save waits for the one before it, and applies its edit to the settings as they are when
// its turn comes. Without that, a toggle flipped while a text edit was being saved would be built
// from the old settings and undo it.
import type { CirclebackSyncSettings } from "../settings/types";
import { logger } from "../util/logger";
import { changedOutputSettings } from "./outputSettings";

/** An edit: the settings it is given, changed. It must return new settings, not change the ones it got. */
export type Edit = (settings: CirclebackSyncSettings) => CirclebackSyncSettings;

/** What the saver needs from a debounced function. Obsidian's `Debouncer` has both. */
export interface Debounced {
  (): unknown;
  /** Calls the function now if a call is waiting, and does nothing otherwise. */
  run(): unknown;
}

export interface SettingsSaverDeps {
  /** The settings store: `save` writes data.json and then updates `current`. */
  store: { readonly current: CirclebackSyncSettings; save(next: CirclebackSyncSettings): Promise<void> };
  /** Makes the debounced form of a function. The tab passes Obsidian's `debounce`, set to 500 ms. */
  debounce: (callback: () => void) => Debounced;
  /** A save failed. The saver has already logged why; this is for telling the user. */
  onSaveError: () => void;
  /** The tab closed after a setting that shapes the notes was changed. Called at most once per close. */
  onOutputChanged: (changed: string[]) => void;
}

export class SettingsSaver {
  /** The settings as they were when the tab opened; null while it is closed. */
  private opened: CirclebackSyncSettings | null = null;
  private sessionNumber = 0;
  /** Edits waiting for the debounce. */
  private queued: Edit[] = [];
  /** The last save, which the next one waits for. It never rejects. */
  private saving: Promise<void> = Promise.resolve();
  private readonly saveQueued: Debounced;

  constructor(private readonly deps: SettingsSaverDeps) {
    this.saveQueued = deps.debounce(() => this.applyQueued());
  }

  /** Whether the tab is open, from `open()` to `close()`. */
  get isOpen(): boolean {
    return this.opened !== null;
  }

  /**
   * Changes whenever the tab opens or closes. A slow answer (a connection test) takes the number
   * when it starts and is dropped if it is different when the answer comes.
   */
  get session(): number {
    return this.sessionNumber;
  }

  /** The tab opened. A second call during the same session, as a redraw makes, changes nothing. */
  open(): void {
    if (this.opened !== null) return;
    this.opened = { ...this.deps.store.current };
    this.sessionNumber += 1;
  }

  /**
   * The tab closed. Saves what is waiting, then, once every save is done, tells `onOutputChanged`
   * which output settings differ from when the tab opened. Resolves when that is finished.
   */
  close(): Promise<void> {
    const before = this.opened;
    this.opened = null;
    if (before !== null) this.sessionNumber += 1;
    this.saveQueued.run();
    return this.saving.then(() => {
      if (before === null) return;
      const changed = changedOutputSettings(before, this.deps.store.current);
      if (changed.length === 0) return;
      try {
        this.deps.onOutputChanged(changed);
      } catch (error) {
        logger.error("Could not tell the user which settings need a full sync.", error);
      }
    });
  }

  /**
   * Counts the changes so far as dealt with: a full sync is about to rewrite the notes, so closing
   * the tab should not offer one again for them. Does nothing while the tab is closed.
   */
  async rebase(): Promise<void> {
    await this.flush();
    if (this.opened !== null) this.opened = { ...this.deps.store.current };
  }

  /** Queues an edit for a text or number field. */
  later(edit: Edit): void {
    this.queued.push(edit);
    this.saveQueued();
  }

  /** Saves an edit now, after the edits that are waiting. */
  commit(edit: Edit): Promise<void> {
    this.saveQueued.run();
    return this.enqueue(edit);
  }

  /** Saves what is waiting and resolves when every save so far has finished. */
  async flush(): Promise<void> {
    this.saveQueued.run();
    await this.saving;
  }

  private applyQueued(): void {
    const edits = this.queued;
    this.queued = [];
    if (edits.length === 0) return;
    void this.enqueue((settings) => edits.reduce((next, edit) => edit(next), settings));
  }

  private enqueue(edit: Edit): Promise<void> {
    const { store } = this.deps;
    this.saving = this.saving.then(async () => {
      try {
        await store.save(edit(store.current));
      } catch (error) {
        logger.error("Could not save the settings.", error);
        this.deps.onSaveError();
      }
    });
    return this.saving;
  }
}
