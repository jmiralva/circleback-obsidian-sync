// The settings tab. It only builds the page and passes edits on: what an edit does lives in
// settingsEdits.ts, what the page says and shows in settingsView.ts, which settings need a
// full sync in outputSettings.ts, and closing the settings window in settingsWindow.ts, all of
// which have tests. This file needs a DOM, so it has none.
//
// Saving is in settingsSaver.ts: toggles and dropdowns save at once, text and number fields once
// typing pauses, and the tab asks the saver to save what is waiting before it redraws, starts a
// sync, or closes.
import { Notice, PluginSettingTab, Setting, debounce } from "obsidian";
import type { App, ButtonComponent, TFile, TextComponent } from "obsidian";
import type CirclebackSyncPlugin from "../main";
import type { AccountConfig, CirclebackSyncSettings } from "../settings/types";
import { logger } from "../util/logger";
import type { Kind } from "../vault/meetingIndex";
import { clearKey, commitKey, testKey } from "./accountKeys";
import type { KeyChange } from "./accountKeys";
import { KEY_NOT_SAVED, LOGS_COPIED, LOGS_NOT_COPIED, SETTINGS_NOT_SAVED, settingsChangeNotice } from "./notices";
import { RemoveAccountModal } from "./removeAccountModal";
import { addAccount, parseWholeNumber, removeAccount, trimFolder, updateAccount, withField } from "./settingsEdits";
import { SettingsSaver } from "./settingsSaver";
import type { Edit, SettingsChange } from "./settingsSaver";
import {
  REMOVE_ACCOUNT_TEXT,
  accountTitle,
  fullSyncButtonText,
  fullSyncDescription,
  keyRowView,
  settingsVisibility,
} from "./settingsView";
import type { SettingsVisibility } from "./settingsView";
import { closeSettingsWindow } from "./settingsWindow";

type Settings = CirclebackSyncSettings;

// The settings of one kind, so that a control can only be given a setting it can hold.
type FieldOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];
type BooleanField = FieldOf<boolean>;
type NumberField = FieldOf<number>;
type TextField = { [K in keyof Settings]: string extends Settings[K] ? K : never }[keyof Settings];
type ChoiceField = Exclude<FieldOf<string>, TextField>;
type Options<K extends ChoiceField> = ReadonlyArray<readonly [Settings[K], string]>;

const SAVE_DELAY_MS = 500;

const SHARED_SETTINGS_NOTE = "Everything below applies to every account.";
const NO_DUPLICATES = "No duplicates found in the last sync on this device.";
// Kept as constants, not inline, so the sentence case check does not lowercase the brand name.
const SELF_NAME_DESC =
  "The speaker name that is you in transcripts. The plugin looks for it among the speakers to recognize your lines, and labels them as Self label says. It wins over the name found in your meetings, which is used when this is empty.";

const NOTE_VARIABLES = "{title}, {date} (2026-10-27), {time} (13-45-00), {year}, {month}, {day} and {quarter} (Q4)";
// A folder has no title to use.
const FOLDER_VARIABLES = "{date} (2026-10-27), {time} (13-45-00), {year}, {month}, {day} and {quarter} (Q4)";
const HEADING_ADVICE =
  "Include the # marks, for example ## Meetings, and match the heading in your daily note template, or the plugin adds a second heading.";

const SUBFOLDER_OPTIONS = [
  ["none", "None"],
  ["day", "By day"],
  ["month", "By month"],
  ["year-month", "Year, then month"],
  ["year-quarter", "Year, then quarter"],
  ["custom", "Custom pattern"],
] as const;
const SUBFOLDER_HELP = "By day is 2026-10-27, by month 2026-10, year then month 2026/10, and year then quarter 2026/Q4.";

const DUPLICATE_KINDS: Record<Kind, string> = {
  note: "Note",
  transcript: "Transcript",
  combined: "Note with transcript",
};

// Obsidian 1.13 prefers declarative setting definitions (`getSettingDefinitions`) to `display`, but
// this plugin supports 1.11.4 (manifest.json), which has only `display`.
export class CirclebackSettingTab extends PluginSettingTab {
  private readonly saver: SettingsSaver;
  /** What "Test connection" said for each account, kept across redraws until the tab closes. */
  private readonly testResults = new Map<string, string>();
  /** The full sync button on the page now, so it can follow the sync without a redraw. */
  private fullSyncButton: ButtonComponent | null = null;

  constructor(
    app: App,
    private readonly plugin: CirclebackSyncPlugin,
  ) {
    super(app, plugin);
    this.saver = new SettingsSaver({
      store: plugin.settingsStore,
      debounce: (callback) => debounce(callback, SAVE_DELAY_MS, true),
      onSaveError: () => {
        new Notice(SETTINGS_NOT_SAVED);
      },
      onSettingsChanged: (change) => this.showChangeNotice(change),
    });
  }

  display(): void {
    this.saver.open();
    this.render();
  }

  /** Saves what is pending, then tells the user if a setting that shapes the notes changed. */
  hide(): void {
    super.hide();
    this.testResults.clear();
    this.fullSyncButton = null;
    void this.saver.close();
  }

  /** Called whenever the plugin's status changes, which includes a full sync starting and ending. */
  refreshFullSyncButton(): void {
    if (!this.saver.isOpen || this.fullSyncButton === null) return;
    this.fullSyncButton.setButtonText(fullSyncButtonText(this.fullSyncRunning()));
  }

  private fullSyncRunning(): boolean {
    return this.plugin.runner.fullSyncProgress !== null;
  }

  /** Builds the page from the current settings. Nothing is built while the tab is closed. */
  private render(): void {
    if (!this.saver.isOpen) return;
    const { containerEl } = this;
    const scroll = containerEl.scrollTop;
    containerEl.empty();
    const settings = this.plugin.settingsStore.current;
    const show = settingsVisibility(settings);

    this.accountsGroup(containerEl, settings);
    this.syncGroup(containerEl, settings);
    this.filteringGroup(containerEl, settings, show);
    this.notesGroup(containerEl, settings, show);
    if (show.transcripts) this.transcriptsGroup(containerEl, settings, show);
    this.duplicatesGroup(containerEl, settings);
    this.advancedGroup(containerEl, settings);
    // Without this a redraw jumps back to the top.
    containerEl.scrollTop = scroll;
  }

  /** Saves what is waiting and then redraws, so that no field shows a value older than what was typed. */
  private async redraw(): Promise<void> {
    await this.saver.flush();
    this.render();
  }

  // ---- Groups, in the order of the spec ----

  private accountsGroup(el: HTMLElement, settings: Settings): void {
    new Setting(el).setName("Accounts").setHeading();
    new Setting(el)
      .setName("Add account")
      .setDesc("Each account uses its own API key. Add one to start syncing.")
      .addButton((button) =>
        button
          .setButtonText("Add account")
          .setCta()
          .onClick(() => {
            void this.commit((current) => addAccount(current, crypto.randomUUID()), true);
          }),
      );
    for (const account of settings.accounts) this.accountBlock(el, account);
    // The groups below Accounts are not per account, and nothing else on the page says so.
    if (settings.accounts.length > 0) el.createEl("p", { text: SHARED_SETTINGS_NOTE, cls: "setting-item-description" });
  }

  private accountBlock(el: HTMLElement, account: AccountConfig): void {
    const block = el.createDiv({ cls: "circleback-sync-account" });
    const { id } = account;

    // The title follows a label change at the next redraw, not while typing.
    new Setting(block).setName(accountTitle(account.label)).setHeading().settingEl.addClass("circleback-sync-account-title");

    let label = account.label;
    new Setting(block)
      .setName("Label")
      .setDesc("A name that tells your accounts apart, for example a work account and a personal one.")
      .addText((text) => {
        text.setValue(label).onChange((value) => {
          const trimmed = value.trim();
          // An account with no label could not be told apart in the status bar.
          if (trimmed === "") return;
          label = trimmed;
          this.saver.later((current) => updateAccount(current, id, { label: trimmed }));
        });
        text.inputEl.addEventListener("change", () => {
          if (text.inputEl.value.trim() === "") text.inputEl.value = label;
        });
      });

    // The key row changes in place when the key changes. A redraw would replace the button the user
    // is clicking: leaving the field fires `change`, which comes before the click on the next control.
    const keyRow: { text: TextComponent | null; clear: ButtonComponent | null } = { text: null, clear: null };
    const keySetting = new Setting(block).setName("API key");
    keySetting.addText((text) => {
      keyRow.text = text;
      text.inputEl.type = "password";
      text.inputEl.autocomplete = "off";
      // `change` fires on Enter or when the field loses focus, not on every key press.
      text.inputEl.addEventListener("change", () => showKeyChange(commitKey(this.plugin, id, text.inputEl.value)));
    });
    keySetting.addButton((button) => {
      keyRow.clear = button;
      button.setButtonText("Clear key").onClick(() => showKeyChange(clearKey(this.plugin, id)));
    });
    const showKey = (): void => {
      // The stored key is never shown: the field is empty until something is pasted.
      const view = keyRowView(this.plugin.keys.get(id) !== null, this.plugin.device.account(id));
      keySetting.setDesc(view.status);
      keyRow.text?.setPlaceholder(view.placeholder);
      if (view.canClear) keyRow.clear?.buttonEl.show();
      else keyRow.clear?.buttonEl.hide();
    };
    const showKeyChange = (change: KeyChange): void => {
      if (!change.ok) {
        // The field keeps what was typed, so the user can try again.
        new Notice(KEY_NOT_SAVED);
        return;
      }
      keyRow.text?.setValue("");
      // The result belongs to the old key.
      this.testResults.delete(id);
      resultEl.setText("");
      this.plugin.refreshStatus();
      showKey();
    };
    showKey();

    new Setting(block)
      .setName("Test connection")
      .setDesc("Checks the API key and shows the email it belongs to.")
      .addButton((button) =>
        button.setButtonText("Test connection").onClick(() => {
          void this.testConnection(id, button, resultEl);
        }),
      );
    // Under the button's row. It is created after the row; the click handler above reaches it later.
    const resultEl = block.createDiv({ cls: "circleback-sync-test-result", text: this.testResults.get(id) ?? "" });

    new Setting(block)
      .setName("Your name in transcripts")
      .setDesc(SELF_NAME_DESC)
      .addText((text) =>
        text.setValue(account.selfNameOverride).onChange((value) => {
          this.saver.later((current) => updateAccount(current, id, { selfNameOverride: value.trim() }));
        }),
      );

    new Setting(block)
      .setName("Remove account")
      .setDesc(REMOVE_ACCOUNT_TEXT)
      .addButton((button) => {
        // What `setWarning` does; that method is deprecated from Obsidian 1.13, and 1.11.4 is supported.
        button.buttonEl.addClass("mod-warning");
        button.setButtonText("Remove").onClick(() => {
          void this.confirmRemove(id);
        });
      });
  }

  private syncGroup(el: HTMLElement, settings: Settings): void {
    new Setting(el).setName("Sync").setHeading();
    this.addToggle(
      el, settings, "periodicSync", "Periodic sync",
      "Sync automatically in the background. This turns on when you add your first account.",
    );
    this.addNumber(el, settings, "syncIntervalMinutes", "Sync interval (minutes)", "How often to sync.", 1, 1440);
    this.addNumber(
      el, settings, "settleDelayMinutes", "Settle delay (minutes)",
      "How long to wait after Obsidian starts or the computer wakes before the next automatic sync, so your sync service can catch up.",
      0, 1440,
    );
    // Device-local, not part of data.json: another device sharing the vault keeps its own choice.
    new Setting(el)
      .setName("Sync on this device")
      .setDesc("Turn this off on a device that should not sync, for example when another device sharing this vault does the syncing. It is saved on this device only.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.device.syncOnThisDevice).onChange((value) => {
          this.plugin.device.syncOnThisDevice = value;
          this.plugin.refreshStatus();
        }),
      );
    this.addToggle(el, settings, "syncNotes", "Sync notes", "Write a note for each meeting. Turn this off to sync only transcripts.");
    this.addToggle(
      el, settings, "syncTranscripts", "Sync transcripts",
      "Also write each meeting's transcript. The transcript settings appear below when this is on.",
      true,
    );
    this.addToggle(
      el, settings, "showSyncNotifications", "Show sync notifications",
      "Show a notice when an automatic sync updates notes or cannot write some. An account that stops syncing or starts again, and any sync you start yourself, always get a notice.",
    );
  }

  private filteringGroup(el: HTMLElement, settings: Settings, show: SettingsVisibility): void {
    new Setting(el).setName("Filtering").setHeading();
    this.addNumber(
      el, settings, "syncDaysBack", "Sync history (days)",
      "How far back each sync looks for meetings. A full sync ignores this.",
      1, 3650,
    );
    this.addToggle(
      el, settings, "includeShared", "Include shared meetings",
      "Also sync meetings that colleagues shared with you, your team or your workspace. This can bring in many more meetings.",
    );
    this.addChoice(el, settings, "titleFilterMode", "Title filter", "Sync only some meetings, based on their title.", [
      ["disabled", "Off"],
      ["include", "Only titles containing the keyword"],
      ["exclude", "Skip titles containing the keyword"],
    ]);
    if (show.titleKeyword) {
      this.addText(
        el, settings, "titleFilterKeyword", "Title filter keyword",
        "The text to look for in meeting titles. Capital letters do not matter. With no keyword, the filter does nothing.",
      );
    }
  }

  private notesGroup(el: HTMLElement, settings: Settings, show: SettingsVisibility): void {
    new Setting(el).setName("Notes").setHeading();
    this.addToggle(el, settings, "includePrivateNotes", "Include private notes", "Add the private notes you wrote on a meeting to its note.");
    this.addToggle(
      el, settings, "includeActionItems", "Include action items",
      "Add the meeting's action items to its note. They are left out when the meeting's notes already have an action items section.",
    );
    this.addToggle(el, settings, "includeInsights", "Include insights", "Add the meeting's insights to its note.");
    this.addChoice(
      el, settings, "saveAs", "Save as",
      "Write each meeting as a file of its own, or as a section inside the daily note for its day.",
      [
        ["files", "Individual files"],
        ["sections", "Sections in daily notes"],
      ],
    );

    if (show.fileSettings) {
      this.addChoice(
        el, settings, "baseFolderType", "Base folder",
        "Where notes are saved. After a change, notes in the old folder are no longer updated.",
        [
          ["custom", "Custom folder"],
          ["daily-notes", "Daily notes folder"],
        ],
      );
      if (show.customBaseFolder) {
        this.addText(
          el, settings, "customBaseFolder", "Custom base folder",
          "The vault folder where notes are saved. After a change, notes in the old folder are no longer updated.",
          trimFolder,
        );
      }
      this.addChoice(
        el, settings, "subfolderPattern", "Subfolders",
        `Sort notes into folders inside the base folder. ${SUBFOLDER_HELP}`,
        SUBFOLDER_OPTIONS,
      );
      if (show.customSubfolder) {
        this.addText(
          el, settings, "customSubfolderPattern", "Custom subfolder pattern",
          `The folders to use inside the base folder. You can use ${FOLDER_VARIABLES}. A / makes a folder inside a folder.`,
          trimFolder,
        );
      }
      this.addText(
        el, settings, "filenamePattern", "Filename pattern",
        `What each note file is called, without .md. You can use ${NOTE_VARIABLES}.`,
      );
      this.addToggle(
        el, settings, "linkFromDailyNotes", "Link from daily notes",
        "Add a link to each meeting's note in the daily note for its day.",
        true,
      );
      if (show.linkHeading) {
        this.addText(
          el, settings, "dailyNoteLinkHeading", "Link heading",
          `The heading in your daily notes that the links go under. ${HEADING_ADVICE}`,
        );
      }
    }

    if (show.sectionHeading) {
      this.addText(
        el, settings, "dailyNoteSectionHeading", "Section heading",
        `The heading in your daily notes that meeting notes go under. ${HEADING_ADVICE}`,
      );
    }
    if (show.createMissingDailyNotes) {
      this.addChoice(
        el, settings, "createMissingDailyNotes", "Create missing daily notes",
        "When a meeting's day has no daily note, create one so there is somewhere to put the link or section.",
        [
          ["always", "Always"],
          ["today", "Only for today"],
          ["never", "Never"],
        ],
      );
    }
  }

  private transcriptsGroup(el: HTMLElement, settings: Settings, show: SettingsVisibility): void {
    new Setting(el).setName("Transcripts").setHeading();
    this.addChoice(
      el, settings, "transcriptHandling", "Transcript handling",
      "Where transcripts are saved. In the note itself needs individual files and Sync notes on; otherwise the transcript gets a file next to the note.",
      [
        ["custom-location", "Separate files in a custom folder"],
        ["same-location", "Separate files next to the note"],
        ["combined", "In the note itself"],
      ],
    );
    if (show.transcriptFolder) {
      this.addText(
        el, settings, "customTranscriptBaseFolder", "Transcript base folder",
        "The vault folder where transcripts are saved. After a change, transcripts in the old folder are no longer updated.",
        trimFolder,
      );
      this.addChoice(
        el, settings, "transcriptSubfolderPattern", "Transcript subfolders",
        `Sort transcripts into folders inside the transcript base folder. ${SUBFOLDER_HELP}`,
        SUBFOLDER_OPTIONS,
      );
    }
    if (show.transcriptCustomSubfolder) {
      this.addText(
        el, settings, "customTranscriptSubfolderPattern", "Custom transcript subfolder pattern",
        `The folders to use inside the transcript base folder. You can use ${FOLDER_VARIABLES}. A / makes a folder inside a folder.`,
        trimFolder,
      );
    }
    if (show.transcriptFilename) {
      this.addText(
        el, settings, "transcriptFilenamePattern", "Transcript filename pattern",
        `What each transcript file is called, without .md. You can use ${NOTE_VARIABLES}.`,
      );
    }
    this.addChoice(
      el, settings, "selfLabel", "Self label", "How your own lines are labelled in transcripts.",
      [
        ["you", "You"],
        ["name", "Your name"],
      ],
      false,
    );
  }

  private duplicatesGroup(el: HTMLElement, settings: Settings): void {
    new Setting(el).setName("Duplicates").setHeading();
    this.addToggle(
      el, settings, "cleanUpDuplicates", "Clean up duplicates",
      "Moves an extra copy of a meeting's note to the trash, but only when nobody has edited it since the plugin wrote it. Other copies are only listed here.",
    );
    const groups = this.plugin.runner.duplicates;
    if (groups.length === 0) {
      el.createEl("p", { text: NO_DUPLICATES, cls: "setting-item-description" });
      return;
    }
    el.createEl("p", {
      text: "Meetings that still had more than one file after the last sync on this device. The first file in each group is the one that is kept.",
      cls: "setting-item-description",
    });
    const list = el.createDiv({ cls: "circleback-sync-duplicates" });
    for (const group of groups) {
      const item = list.createDiv({ cls: "circleback-sync-duplicate-group" });
      item.createDiv({ text: DUPLICATE_KINDS[group.kind], cls: "circleback-sync-duplicate-kind" });
      const files = item.createEl("ul");
      this.fileLink(files, group.keep, true);
      for (const other of group.others) this.fileLink(files, other, false);
    }
  }

  private advancedGroup(el: HTMLElement, settings: Settings): void {
    new Setting(el).setName("Advanced").setHeading();
    new Setting(el)
      .setName("Full sync")
      .setDesc(fullSyncDescription(settings))
      .addButton((button) => {
        this.fullSyncButton = button;
        // What the click does depends on the sync at that moment, not on when the page was built.
        button.setButtonText(fullSyncButtonText(this.fullSyncRunning())).onClick(() => {
          void this.toggleFullSync();
        });
      });
    this.addToggle(
      el, settings, "debugLogging", "Debug logging",
      "Also print the plugin's log to the developer console. Detail lines are at the Verbose level, so set the console to show Verbose to see them; warnings and errors show at the default levels. The log is kept in memory either way, for Copy logs.",
    );
    new Setting(el)
      .setName("Copy logs")
      .setDesc("Copies the plugin's recent log to the clipboard, with API keys removed.")
      .addButton((button) =>
        button.setButtonText("Copy logs").onClick(() => {
          void this.copyLogs();
        }),
      );
  }

  // ---- Controls ----

  private addToggle(el: HTMLElement, settings: Settings, field: BooleanField, name: string, desc: string, redraw = false): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addToggle((toggle) =>
        toggle.setValue(settings[field]).onChange((value) => {
          void this.commit((current) => withField(current, field, value), redraw);
        }),
      );
  }

  /** A dropdown. It redraws the page by default, since most choices add or remove other settings. */
  private addChoice<K extends ChoiceField>(
    el: HTMLElement, settings: Settings, field: K, name: string, desc: string, options: Options<K>, redraw = true,
  ): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addDropdown((dropdown) => {
        for (const [value, text] of options) dropdown.addOption(value, text);
        dropdown.setValue(settings[field]).onChange((value) => {
          void this.commit((current) => withField(current, field, value as Settings[K]), redraw);
        });
      });
  }

  /** A text field. The text is trimmed, or cleaned some other way, before it is saved. */
  private addText(
    el: HTMLElement, settings: Settings, field: TextField, name: string, desc: string,
    clean: (text: string) => string = (text) => text.trim(),
  ): void {
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((text) =>
        text.setValue(settings[field]).onChange((value) => {
          const cleaned = clean(value);
          this.saver.later((current) => withField(current, field, cleaned));
        }),
      );
  }

  /** A whole-number field. Text that is not a whole number in range is not saved, and the field shows the last good value when left. */
  private addNumber(
    el: HTMLElement, settings: Settings, field: NumberField, name: string, desc: string, min: number, max: number,
  ): void {
    let accepted = settings[field];
    new Setting(el)
      .setName(name)
      .setDesc(desc)
      .addText((text) => {
        text.inputEl.type = "number";
        text.inputEl.min = String(min);
        text.inputEl.max = String(max);
        text.inputEl.title = `Whole number from ${min} to ${max}`;
        text.setValue(String(accepted)).onChange((value) => {
          const parsed = parseWholeNumber(value, min, max);
          if (parsed === null) return;
          accepted = parsed;
          this.saver.later((current) => withField(current, field, parsed));
        });
        text.inputEl.addEventListener("change", () => {
          if (parseWholeNumber(text.inputEl.value, min, max) === null) text.inputEl.value = String(accepted);
        });
      });
  }

  private fileLink(list: HTMLElement, file: TFile, kept: boolean): void {
    const item = list.createEl("li");
    const link = item.createEl("a", { text: file.path, attr: { href: "#" } });
    link.addEventListener("click", (event) => {
      event.preventDefault();
      closeSettingsWindow(this.app);
      void this.app.workspace.openLinkText(file.path, "", true);
    });
    if (kept) item.appendText(" (kept)");
  }

  /** Saves an edit at once (after any text edits that are waiting), then redraws if asked. */
  private async commit(edit: Edit, redraw = false): Promise<void> {
    await this.saver.commit(edit);
    if (redraw) await this.redraw();
  }

  // ---- Actions ----

  private async testConnection(id: string, button: ButtonComponent, resultEl: HTMLElement): Promise<void> {
    button.setDisabled(true);
    resultEl.setText("Testing the connection...");
    const session = this.saver.session;
    try {
      // An answer for a key that has since changed, or for a tab that has since closed, is dropped.
      const text = await testKey(this.plugin, id, () => this.saver.session === session);
      if (text === null) return;
      this.testResults.set(id, text);
      resultEl.setText(text);
    } finally {
      button.setDisabled(false);
    }
  }

  /** Asks first: the account list is in data.json, so removing is removing on every device sharing the vault. */
  private async confirmRemove(id: string): Promise<void> {
    // A label typed a moment ago should be the one in the question.
    await this.saver.flush();
    const label = this.plugin.settingsStore.current.accounts.find((account) => account.id === id)?.label;
    if (label === undefined) return;
    new RemoveAccountModal(this.app, label, () => {
      void this.removeAccountAndKey(id);
    }).open();
  }

  private async removeAccountAndKey(id: string): Promise<void> {
    this.plugin.keys.clear(id);
    this.testResults.delete(id);
    await this.commit((current) => removeAccount(current, id));
    this.plugin.refreshStatus();
    await this.redraw();
  }

  private async toggleFullSync(): Promise<void> {
    if (this.fullSyncRunning()) this.plugin.runner.cancelFullSync();
    else await this.startFullSync();
    // The button follows the sync through `refreshFullSyncButton`, which the runner's status updates reach.
  }

  /** Starts a full sync, from the button or from the notice. */
  private async startFullSync(): Promise<void> {
    // The sync reads the settings when it starts, so edits still waiting are saved first. It also
    // rewrites the notes for the changes made so far, so closing the tab must not offer a full sync
    // for them again.
    await this.saver.rebase();
    void this.plugin.runner.startFullSync();
  }

  private async copyLogs(): Promise<void> {
    try {
      await navigator.clipboard.writeText(logger.dump());
      new Notice(LOGS_COPIED);
    } catch (error) {
      logger.error("Could not copy the logs.", error);
      new Notice(LOGS_NOT_COPIED);
    }
  }

  /**
   * What the settings changed in this visit mean for existing notes (`settingsChangeNotice` picks
   * the words, the button and how long the notice stays).
   * - A change to what notes say offers a full sync, since a full sync is what updates the older
   *   notes, and stays until it is dismissed or its button is used.
   * - A sync folder that dropped out, with no such change, also stays until dismissed: the notes
   *   there are no longer updated. It has no button because nothing needs a full sync: meetings get
   *   new notes in the new folder as they sync, and a full sync from Advanced only does it sooner.
   * - A change only to subfolders and file names goes by itself: every note is still in the sync
   *   folders and still updated, and a full sync would not move or rename one.
   */
  private showChangeNotice(change: SettingsChange): void {
    const { text, offerFullSync, untilDismissed } = settingsChangeNotice(change);
    // 0 keeps a notice until it is dismissed; undefined is Obsidian's usual few seconds.
    const duration = untilDismissed ? 0 : undefined;
    if (!offerFullSync) {
      new Notice(text, duration);
      return;
    }
    const fragment = createFragment((content) => {
      content.createDiv({ text });
      const button = content.createEl("button", { text: "Run full sync", cls: "mod-cta circleback-sync-notice-button" });
      button.addEventListener("click", () => {
        void this.startFullSync();
        notice.hide();
      });
    });
    const notice = new Notice(fragment, duration);
  }
}
