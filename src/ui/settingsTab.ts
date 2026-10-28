// The settings tab. It only builds the page and passes edits on: what an edit does lives in
// settingsEdits.ts, what the page says and shows in settingsView.ts, and which settings need a
// full sync in outputSettings.ts, all of which have tests. This file needs a DOM, so it has none.
//
// Saving: toggles and dropdowns save at once. Text and number fields save through one 500 ms
// debounce, so typing does not write data.json on every key, and the tab flushes it before it
// redraws, starts a sync, or closes. Every save waits for the one before it, so two edits made
// close together cannot overwrite each other.
import { Notice, PluginSettingTab, Setting, debounce } from "obsidian";
import type { App, ButtonComponent, TFile } from "obsidian";
import type CirclebackSyncPlugin from "../main";
import type { AccountConfig, CirclebackSyncSettings } from "../settings/types";
import { logger } from "../util/logger";
import type { Kind } from "../vault/meetingIndex";
import { LOGS_COPIED, LOGS_NOT_COPIED, OUTPUT_CHANGE_NOTICE, SETTINGS_NOT_SAVED } from "./notices";
import { changedOutputSettings } from "./outputSettings";
import { addAccount, parseWholeNumber, removeAccount, trimFolder, updateAccount, withField } from "./settingsEdits";
import { accountStatusLine, checkConnection, fullSyncDescription, settingsVisibility } from "./settingsView";
import type { SettingsVisibility } from "./settingsView";

type Settings = CirclebackSyncSettings;
type Edit = (settings: Settings) => Settings;

// The settings of one kind, so that a control can only be given a setting it can hold.
type FieldOf<T> = { [K in keyof Settings]: Settings[K] extends T ? K : never }[keyof Settings];
type BooleanField = FieldOf<boolean>;
type NumberField = FieldOf<number>;
type TextField = { [K in keyof Settings]: string extends Settings[K] ? K : never }[keyof Settings];
type ChoiceField = Exclude<FieldOf<string>, TextField>;
type Options<K extends ChoiceField> = ReadonlyArray<readonly [Settings[K], string]>;

const SAVE_DELAY_MS = 500;

const NO_DUPLICATES = "No duplicates found in the last sync on this device.";
// Kept as constants, not inline, so the sentence case check does not lowercase the brand name.
const SELF_NAME_DESC =
  "Your name as it should appear in transcripts. Leave empty to use the name Circleback has for you.";
const KEY_PLACEHOLDER = "Paste your Circleback API key";

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
  /** The settings as they were when the tab opened, to tell at close which output settings changed. */
  private opened: Settings | null = null;
  /** Text and number edits waiting for the debounce; applied together in one save. */
  private queued: Edit[] = [];
  /** The last save. Each new save waits for it, and it never rejects. */
  private saving: Promise<void> = Promise.resolve();
  /** What "Test connection" said for each account, kept across redraws until the tab closes. */
  private readonly testResults = new Map<string, string>();
  private readonly flushQueued = debounce(() => this.applyQueued(), SAVE_DELAY_MS, true);

  constructor(
    app: App,
    private readonly plugin: CirclebackSyncPlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    this.render();
  }

  /** Saves what is pending, then tells the user if a setting that shapes the notes changed. */
  hide(): void {
    const before = this.opened;
    this.opened = null;
    this.testResults.clear();
    this.flushQueued.run();
    // The saves are asynchronous: the changed settings are only in place once they finish.
    void this.saving.then(() => {
      if (before === null) return;
      if (changedOutputSettings(before, this.plugin.settingsStore.current).length > 0) this.showOutputNotice();
    });
  }

  /** Builds the page from the current settings. Also the redraw after a change that adds or removes settings. */
  private render(): void {
    const { containerEl } = this;
    const scroll = containerEl.scrollTop;
    containerEl.empty();
    const settings = this.plugin.settingsStore.current;
    this.opened ??= { ...settings };
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
  }

  private accountBlock(el: HTMLElement, account: AccountConfig): void {
    const block = el.createDiv({ cls: "circleback-sync-account" });
    const { id } = account;
    const hasKey = this.plugin.keys.get(id) !== null;

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
          this.editLater((current) => updateAccount(current, id, { label: trimmed }));
        });
        text.inputEl.addEventListener("change", () => {
          if (text.inputEl.value.trim() === "") text.inputEl.value = label;
        });
      });

    new Setting(block)
      .setName("API key")
      .setDesc(accountStatusLine(hasKey, this.plugin.device.account(id)))
      .addText((text) => {
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
        // The stored key is never shown, so the field is empty until something is pasted.
        text.setPlaceholder(hasKey ? "Stored on this device" : KEY_PLACEHOLDER);
        // `change` fires on Enter or when the field loses focus, not on every key press.
        text.inputEl.addEventListener("change", () => this.saveKey(id, text.inputEl));
      });

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
          this.editLater((current) => updateAccount(current, id, { selfNameOverride: value.trim() }));
        }),
      );

    new Setting(block)
      .setName("Remove account")
      .setDesc("Removes the account and its API key from this device. Its notes stay in the vault.")
      .addButton((button) => {
        // What `setWarning` does; that method is deprecated from Obsidian 1.13, and 1.11.4 is supported.
        button.buttonEl.addClass("mod-warning");
        button.setButtonText("Remove").onClick(() => {
          void this.removeAccountAndKey(id);
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
      "Show a notice when an automatic sync updates notes. Problems are always shown.",
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
      this.addChoice(el, settings, "baseFolderType", "Base folder", "Where notes are saved.", [
        ["custom", "Custom folder"],
        ["daily-notes", "Daily notes folder"],
      ]);
      if (show.customBaseFolder) {
        this.addText(el, settings, "customBaseFolder", "Custom base folder", "The vault folder where notes are saved.", trimFolder);
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
        "The vault folder where transcripts are saved.",
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
    const running = this.plugin.runner.fullSyncProgress !== null;
    new Setting(el)
      .setName("Full sync")
      .setDesc(fullSyncDescription(settings))
      .addButton((button) =>
        button.setButtonText(running ? "Cancel full sync" : "Start full sync").onClick(() => {
          void this.toggleFullSync(running);
        }),
      );
    this.addToggle(
      el, settings, "debugLogging", "Debug logging",
      "Also print the plugin's log to the developer console. Its lines are at the Verbose level, so set the console to show Verbose. The log is kept in memory either way, for Copy logs.",
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
          this.editLater((current) => withField(current, field, cleaned));
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
          this.editLater((current) => withField(current, field, parsed));
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
      void this.app.workspace.openLinkText(file.path, "", true);
    });
    if (kept) item.appendText(" (kept)");
  }

  // ---- Saving ----

  /** Saves the edit at once, after any text edits that are waiting, then redraws if asked. */
  private async commit(edit: Edit, redraw = false): Promise<void> {
    this.flushQueued.run();
    await this.enqueueSave(edit);
    if (redraw) this.render();
  }

  /** Queues a text or number edit; the debounce saves it, together with any others, once typing pauses. */
  private editLater(edit: Edit): void {
    this.queued.push(edit);
    this.flushQueued();
  }

  private applyQueued(): void {
    const edits = this.queued;
    this.queued = [];
    if (edits.length === 0) return;
    void this.enqueueSave((settings) => edits.reduce((next, edit) => edit(next), settings));
  }

  /** Saves what is queued and waits until every save so far has finished. */
  private async flush(): Promise<void> {
    this.flushQueued.run();
    await this.saving;
  }

  /** Each edit is applied to the settings as they are when its turn comes, not as they were when it was made. */
  private enqueueSave(edit: Edit): Promise<void> {
    const { settingsStore } = this.plugin;
    this.saving = this.saving.then(async () => {
      try {
        await settingsStore.save(edit(settingsStore.current));
      } catch (error) {
        logger.error("Could not save the settings.", error);
        new Notice(SETTINGS_NOT_SAVED);
      }
    });
    return this.saving;
  }

  // ---- Actions ----

  private saveKey(id: string, input: HTMLInputElement): void {
    const { keys, device } = this.plugin;
    // The key store does not trim, and a pasted key often has a space or a newline after it.
    const value = input.value.trim();
    if (value === "") keys.clear(id);
    else keys.set(id, value);
    // The cached owner belongs to the old key; a key for someone else must not keep their email.
    device.update(id, { ownerEmail: undefined, ownerName: undefined });
    input.value = "";
    this.testResults.delete(id);
    this.plugin.refreshStatus();
    this.render();
  }

  private async testConnection(id: string, button: ButtonComponent, resultEl: HTMLElement): Promise<void> {
    button.setDisabled(true);
    resultEl.setText("Testing the connection...");
    try {
      const outcome = await checkConnection(this.plugin.keys.get(id), (key) => this.plugin.clientFor(key));
      if (outcome.email !== undefined) this.plugin.device.update(id, { ownerEmail: outcome.email });
      this.testResults.set(id, outcome.text);
      resultEl.setText(outcome.text);
    } finally {
      button.setDisabled(false);
    }
  }

  private async removeAccountAndKey(id: string): Promise<void> {
    this.plugin.keys.clear(id);
    this.testResults.delete(id);
    await this.commit((current) => removeAccount(current, id));
    this.plugin.refreshStatus();
    this.render();
  }

  private async toggleFullSync(running: boolean): Promise<void> {
    if (running) {
      this.plugin.runner.cancelFullSync();
    } else {
      // The sync reads the settings when it starts, so an edit still waiting must be saved first.
      await this.flush();
      void this.plugin.runner.startFullSync();
    }
    // The sync reports its progress a moment after it starts, so the button is redrawn after that.
    window.setTimeout(() => this.render(), 100);
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

  /** A notice that stays until it is dismissed or its button is used. */
  private showOutputNotice(): void {
    const fragment = createFragment((content) => {
      content.createDiv({ text: OUTPUT_CHANGE_NOTICE });
      const button = content.createEl("button", { text: "Run full sync", cls: "mod-cta circleback-sync-notice-button" });
      button.addEventListener("click", () => {
        void this.plugin.runner.startFullSync();
        notice.hide();
      });
    });
    const notice = new Notice(fragment, 0);
  }
}
