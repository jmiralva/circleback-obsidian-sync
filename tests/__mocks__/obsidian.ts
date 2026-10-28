// Jest stand-in for the "obsidian" package (see moduleNameMapper in jest.config.js).
// Only what the plugin and the FakeApp harness need. Later tasks may add to it,
// but must not change behavior that earlier tests rely on.
import moment from "moment";
import { dump, load } from "js-yaml";
import type { App, PluginManifest } from "obsidian";

export { moment };

export const requestUrl = jest.fn();

// Obsidian's `debounce`: calls `cb` once `timeout` ms after the last call when `resetTimer` is true.
// `run` calls it at once if a call is pending, and `cancel` drops the pending call.
export function debounce<T extends unknown[], V>(
  cb: (...args: T) => V,
  timeout = 0,
  resetTimer = false,
): ((...args: T) => unknown) & { cancel(): unknown; run(): V | void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  const fire = (): V | void => {
    timer = null;
    const args = pending;
    pending = null;
    if (args !== null) return cb(...args);
  };
  const debounced = (...args: T): unknown => {
    pending = args;
    if (timer !== null && resetTimer) {
      clearTimeout(timer);
      timer = null;
    }
    timer ??= setTimeout(fire, timeout);
    return debounced;
  };
  debounced.cancel = (): unknown => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = null;
    return debounced;
  };
  debounced.run = (): V | void => {
    if (timer === null) return;
    clearTimeout(timer);
    return fire();
  };
  return debounced;
}

export class Notice {
  constructor(
    public message: string,
    public timeout?: number,
  ) {}

  setMessage(message: string): this {
    this.message = message;
    return this;
  }

  hide(): void {}
}

// What `addStatusBarItem` hands back: the few element methods the plugin calls, recording what it did.
export class FakeStatusBarItem {
  text = "";
  hidden = false;

  setText(text: string): void {
    this.text = text;
  }

  hide(): void {
    this.hidden = true;
  }

  show(): void {
    this.hidden = false;
  }
}

export class Plugin {
  app: App;
  manifest: PluginManifest;
  private saved: string | null = null;

  // Recorders for what a plugin registers, so tests can look at it (and run the clean-ups).
  readonly commands: Array<{ id: string; name: string; [field: string]: unknown }> = [];
  readonly statusBarItems: FakeStatusBarItem[] = [];
  readonly registeredEvents: unknown[] = [];
  readonly cleanups: Array<() => void> = [];
  readonly intervals: number[] = [];
  readonly settingTabs: unknown[] = [];

  constructor(app: App, manifest: PluginManifest) {
    this.app = app;
    this.manifest = manifest;
  }

  // data.json stand-in. Values pass through JSON, so callers cannot share references with it.
  async loadData(): Promise<unknown> {
    return this.saved === null ? null : (JSON.parse(this.saved) as unknown);
  }

  async saveData(data: unknown): Promise<void> {
    this.saved = data === undefined ? null : JSON.stringify(data);
  }

  addCommand<T extends { id: string; name: string }>(command: T): T {
    this.commands.push(command);
    return command;
  }

  addStatusBarItem(): FakeStatusBarItem {
    const item = new FakeStatusBarItem();
    this.statusBarItems.push(item);
    return item;
  }

  addSettingTab(tab: unknown): void {
    this.settingTabs.push(tab);
  }

  registerEvent(ref: unknown): void {
    this.registeredEvents.push(ref);
  }

  register(cleanup: () => void): void {
    this.cleanups.push(cleanup);
  }

  registerInterval(id: number): number {
    this.intervals.push(id);
    return id;
  }
}

export class PluginSettingTab {
  containerEl: unknown = {};

  constructor(
    public app: App,
    public plugin: Plugin,
  ) {}

  display(): void {}

  hide(): void {}
}

// Every method returns `this` and does nothing, so settings code can run without a DOM.
export class Setting {
  constructor(public containerEl: unknown) {}

  setName(_name: string): this {
    return this;
  }

  setDesc(_desc: string): this {
    return this;
  }

  setHeading(): this {
    return this;
  }

  setClass(_cls: string): this {
    return this;
  }

  setTooltip(_tooltip: string): this {
    return this;
  }

  setDisabled(_disabled: boolean): this {
    return this;
  }

  addText(_cb: unknown): this {
    return this;
  }

  addTextArea(_cb: unknown): this {
    return this;
  }

  addToggle(_cb: unknown): this {
    return this;
  }

  addDropdown(_cb: unknown): this {
    return this;
  }

  addButton(_cb: unknown): this {
    return this;
  }

  addExtraButton(_cb: unknown): this {
    return this;
  }
}

export class TAbstractFile {
  path: string;
  name: string;
  parent: TFolder | null = null;

  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() ?? "";
  }
}

export class TFile extends TAbstractFile {
  basename: string;
  extension: string;
  stat = { ctime: 0, mtime: 0, size: 0 };

  constructor(path: string) {
    super(path);
    const dot = this.name.lastIndexOf(".");
    this.basename = dot < 0 ? this.name : this.name.slice(0, dot);
    this.extension = dot < 0 ? "" : this.name.slice(dot + 1);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];

  isRoot(): boolean {
    return this.path === "/";
  }
}

// Same rules as Obsidian's: one separator style, no leading or trailing slash,
// plain spaces, NFC; an empty result is "/".
export function normalizePath(path: string): string {
  const cleaned = path.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
  if (cleaned === "") return "/";
  return cleaned.replace(/[  ]/g, " ").normalize("NFC");
}

export function parseYaml(yaml: string): unknown {
  return yaml.trim() === "" ? null : load(yaml);
}

export function stringifyYaml(obj: unknown): string {
  return dump(obj, { lineWidth: -1 });
}
