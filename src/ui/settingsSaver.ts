// Saves the edits the settings tab makes, and works out at close which of them the user should be told about.
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
import { OUTPUT_SETTINGS, changedOutputSettings, changedPlacementSettings, syncFolderDropped } from "./outputSettings";

/** An edit: the settings it is given, changed. It must return new settings, not change the ones it got. */
export type Edit = (settings: CirclebackSyncSettings) => CirclebackSyncSettings;

/**
 * What changed between opening and closing the tab, by the kind of setting: `output` settings
 * shape the text of existing notes (a full sync updates it), `placement` settings only decide
 * where new notes go. At least one of the three says something changed.
 */
export interface SettingsChange {
  output: string[];
  placement: string[];
  /**
   * Whether a folder that was a sync folder when the tab opened is outside the sync folders now,
   * so the notes there are no longer updated (see `syncFolderDropped`).
   */
  syncFolderDropped: boolean;
}

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
  /** The tab closed after a setting that shapes the notes or decides where they go was changed. Called at most once per close. */
  onSettingsChanged: (change: SettingsChange) => void;
}

export class SettingsSaver {
  /**
   * The settings as they were when the tab opened, with the output settings moved on by `rebase`;
   * null while it is closed.
   */
  private opened: CirclebackSyncSettings | null = null;
  /**
   * The settings as they were when the tab opened, which `rebase` leaves alone, to tell whether a
   * sync folder dropped out: a full sync does not bring back the notes in a folder that did.
   */
  private atOpen: CirclebackSyncSettings | null = null;
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
    this.atOpen = this.opened;
    this.sessionNumber += 1;
  }

  /**
   * The tab closed. Saves what is waiting, then, once every save is done, tells `onSettingsChanged`
   * which output and placement settings differ from when the tab opened, and whether a sync folder
   * dropped out. Resolves when that is finished.
   */
  close(): Promise<void> {
    const before = this.opened;
    const atOpen = this.atOpen;
    this.opened = null;
    this.atOpen = null;
    if (before !== null) this.sessionNumber += 1;
    this.saveQueued.run();
    return this.saving.then(() => {
      if (before === null || atOpen === null) return;
      const { current } = this.deps.store;
      const change: SettingsChange = {
        output: changedOutputSettings(before, current),
        placement: changedPlacementSettings(before, current),
        syncFolderDropped: syncFolderDropped(atOpen, current),
      };
      if (change.output.length === 0 && change.placement.length === 0 && !change.syncFolderDropped) return;
      try {
        this.deps.onSettingsChanged(change);
      } catch (error) {
        logger.error("Could not tell the user what the changed settings do to existing notes.", error);
      }
    });
  }

  /**
   * Counts the changes so far to the output settings as dealt with: a full sync is about to
   * rewrite the notes, so closing the tab should not offer one again for them. Changes to the
   * placement settings stay counted, since a full sync never moves or renames a note and the
   * user still needs to hear that. So does a sync folder that dropped out, even through an output
   * setting: the notes there are no longer updated, full sync or not. Does nothing while the tab
   * is closed.
   */
  async rebase(): Promise<void> {
    await this.flush();
    if (this.opened === null) return;
    const { current } = this.deps.store;
    const output = Object.fromEntries(OUTPUT_SETTINGS.map((key) => [key, current[key]])) as Partial<CirclebackSyncSettings>;
    this.opened = { ...this.opened, ...output };
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
