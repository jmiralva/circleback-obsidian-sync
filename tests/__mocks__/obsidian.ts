// Jest stand-in for the "obsidian" package (see moduleNameMapper in jest.config.js).
// Only what the plugin and the FakeApp harness need. Later tasks may add to it,
// but must not change behavior that earlier tests rely on.
import moment from "moment";
import { dump, load } from "js-yaml";
import type { App, PluginManifest } from "obsidian";

export { moment };

export const requestUrl = jest.fn();

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

export class Plugin {
  app: App;
  manifest: PluginManifest;
  private saved: string | null = null;

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
