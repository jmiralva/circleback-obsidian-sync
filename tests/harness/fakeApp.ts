// In-memory stand-in for Obsidian's `App`, for tests of code that touches the vault.
//
// It copies the parts of Obsidian's behavior that matter for correctness, including
// the strict parts: `create` refuses existing files and missing folders, `rename`
// refuses existing destinations and missing folders, `processFrontMatter` keeps the
// body byte for byte, and dot-folders (`.obsidian`, `.trash`) are not part of the
// vault index but are still reachable through the adapter.
import { TFile, TFolder, normalizePath, parseYaml, stringifyYaml } from "../__mocks__/obsidian";
import type { App } from "obsidian";

export interface FakeAppOptions {
  /** Initial files, by vault path. Their folders are created implicitly. */
  files?: Record<string, string>;
  /** Markdown files that the metadata cache has not indexed yet (`getFileCache` returns null). */
  unindexed?: string[];
  /**
   * Whether the workspace layout is ready (default true, as for a plugin enabled after startup).
   * When false, `onLayoutReady` callbacks wait until `workspace.fireLayoutReady()`.
   */
  layoutReady?: boolean;
}

export type FakeApp = App & {
  metadataCache: {
    /** Fires the "resolved" event, as Obsidian does when indexing settles. */
    fireResolved(): void;
  };
  workspace: {
    /** Makes the layout ready and runs the callbacks that were waiting, as Obsidian does at startup. */
    fireLayoutReady(): void;
  };
  /** Test helper: the current text of a file, indexed or not. Throws when it does not exist. */
  fileText(path: string): string;
  /** Test helper: whether a file or folder exists, indexed or not. */
  exists(path: string): boolean;
};

type VaultNode = TFile | TFolder;

const CONFIG_DIR = ".obsidian";
const TRASH_DIR = ".trash";
const SECRET_ID = /^[a-z0-9-]{1,64}$/;

// Obsidian does not index dot-folders or dot-files.
function isHidden(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

// "" is the vault root.
function parentOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface FrontmatterParts {
  opening: string;
  yaml: string;
  closing: string;
  body: string;
}

// Splits "---\n<yaml>\n---\n<body>" without touching a byte of the fences or the body.
// A block with no closing fence is not frontmatter.
function splitFrontmatter(text: string): FrontmatterParts | null {
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return null;
  let pos = open[0].length;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const end = newline === -1 ? text.length : newline + 1;
    if (/^---[ \t]*\r?\n?$/.test(text.slice(pos, end))) {
      return {
        opening: open[0],
        yaml: text.slice(open[0].length, pos),
        closing: text.slice(pos, end),
        body: text.slice(end),
      };
    }
    pos = end;
  }
  return null;
}

class FakeVault {
  readonly configDir = CONFIG_DIR;
  readonly adapter = {
    read: async (path: string): Promise<string> => this.textAt(path),
    exists: async (path: string): Promise<boolean> => this.has(path),
  };

  private readonly root = new TFolder("/");
  // Every file and folder, hidden ones included, by path.
  private readonly nodes = new Map<string, VaultNode>();
  private readonly texts = new Map<string, string>();

  constructor(files: Record<string, string>) {
    for (const [rawPath, text] of Object.entries(files)) {
      const path = normalizePath(rawPath);
      this.ensureFolder(parentOf(path));
      this.addFile(path, text);
    }
  }

  getAbstractFileByPath(path: string): VaultNode | null {
    if (path === "/") return this.root;
    return isHidden(path) ? null : (this.nodes.get(path) ?? null);
  }

  getFileByPath(path: string): TFile | null {
    const node = this.getAbstractFileByPath(path);
    return node instanceof TFile ? node : null;
  }

  getFolderByPath(path: string): TFolder | null {
    const node = this.getAbstractFileByPath(path);
    return node instanceof TFolder ? node : null;
  }

  getFiles(): TFile[] {
    return this.indexedFiles();
  }

  getMarkdownFiles(): TFile[] {
    return this.indexedFiles().filter((file) => file.extension === "md");
  }

  async read(file: TFile): Promise<string> {
    return this.textAt(file.path);
  }

  async cachedRead(file: TFile): Promise<string> {
    return this.textAt(file.path);
  }

  async create(path: string, data: string): Promise<TFile> {
    if (this.has(path)) throw new Error("File already exists.");
    this.requireFolder(parentOf(path));
    return this.addFile(path, data);
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.has(path)) throw new Error("Folder already exists.");
    return this.ensureFolder(path);
  }

  async modify(file: TFile, data: string): Promise<void> {
    this.writeText(file, data);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const next = fn(this.textAt(file.path));
    this.writeText(file, next);
    return next;
  }

  async rename(file: VaultNode, newPath: string): Promise<void> {
    if (!this.nodes.has(file.path)) throw new Error(`Cannot rename, no such file: ${file.path}`);
    if (this.has(newPath)) throw new Error("Destination file already exists!");
    this.requireFolder(parentOf(newPath));
    this.moveSubtree(file.path, newPath);
  }

  async delete(file: VaultNode): Promise<void> {
    if (!this.nodes.has(file.path)) throw new Error(`Cannot delete, no such file: ${file.path}`);
    for (const path of this.subtreePaths(file.path)) {
      const node = this.nodes.get(path);
      if (node) this.detach(node);
      this.nodes.delete(path);
      this.texts.delete(path);
    }
  }

  // Helpers for FakeApp itself (not part of Obsidian's API).

  has(path: string): boolean {
    return this.nodes.has(path);
  }

  textAt(path: string): string {
    const text = this.texts.get(path);
    if (text === undefined) throw new Error(`File not found: ${path}`);
    return text;
  }

  writeText(file: TFile, data: string): void {
    if (!this.texts.has(file.path)) throw new Error(`File not found: ${file.path}`);
    this.texts.set(file.path, data);
    file.stat.mtime = Date.now();
    file.stat.size = data.length;
  }

  indexedFiles(): TFile[] {
    const files: TFile[] = [];
    for (const [path, node] of this.nodes) {
      if (node instanceof TFile && !isHidden(path)) files.push(node);
    }
    return files;
  }

  async trash(file: VaultNode): Promise<void> {
    if (!this.has(TRASH_DIR)) this.ensureFolder(TRASH_DIR);
    const dot = file.name.lastIndexOf(".");
    const stem = file instanceof TFile && dot > 0 ? file.name.slice(0, dot) : file.name;
    const ext = file instanceof TFile && dot > 0 ? file.name.slice(dot) : "";
    let target = `${TRASH_DIR}/${file.name}`;
    for (let n = 1; this.has(target); n++) target = `${TRASH_DIR}/${stem} ${n}${ext}`;
    await this.rename(file, target);
  }

  private requireFolder(path: string): void {
    if (path !== "" && !(this.nodes.get(path) instanceof TFolder)) {
      throw new Error(`Folder does not exist: ${path}`);
    }
  }

  private addFile(path: string, data: string): TFile {
    const file = new TFile(path);
    const now = Date.now();
    file.stat = { ctime: now, mtime: now, size: data.length };
    this.nodes.set(path, file);
    this.texts.set(path, data);
    this.attach(file);
    return file;
  }

  private ensureFolder(path: string): TFolder {
    let current = "";
    let folder = this.root;
    for (const segment of path === "" ? [] : path.split("/")) {
      current = current === "" ? segment : `${current}/${segment}`;
      const existing = this.nodes.get(current);
      if (existing instanceof TFile) throw new Error(`Not a folder: ${current}`);
      if (existing) {
        folder = existing;
        continue;
      }
      folder = new TFolder(current);
      this.nodes.set(current, folder);
      this.attach(folder);
    }
    return folder;
  }

  private attach(node: VaultNode): void {
    const parentPath = parentOf(node.path);
    const parent = parentPath === "" ? this.root : this.nodes.get(parentPath);
    if (!(parent instanceof TFolder)) throw new Error(`Folder does not exist: ${parentPath}`);
    node.parent = parent;
    if (!isHidden(node.path)) parent.children.push(node);
  }

  private detach(node: VaultNode): void {
    const siblings = node.parent?.children;
    const index = siblings?.indexOf(node) ?? -1;
    if (siblings && index >= 0) siblings.splice(index, 1);
  }

  // The path itself plus everything below it, shallowest first.
  private subtreePaths(path: string): string[] {
    return [...this.nodes.keys()]
      .filter((p) => p === path || p.startsWith(`${path}/`))
      .sort((a, b) => a.split("/").length - b.split("/").length);
  }

  // Obsidian keeps the same TFile object across a rename. Moving into or out of a dot-folder
  // (the trash) changes what the vault indexes, so those moves leave the old object stale
  // and register a new one.
  private moveSubtree(from: string, to: string): void {
    const moved = this.subtreePaths(from).map((oldPath) => {
      const node = this.nodes.get(oldPath) as VaultNode;
      return { oldPath, node, newPath: to + oldPath.slice(from.length), text: this.texts.get(oldPath) };
    });
    for (const { oldPath, node } of moved) {
      this.detach(node);
      this.nodes.delete(oldPath);
      this.texts.delete(oldPath);
    }
    for (const { oldPath, node, newPath, text } of moved) {
      const keepObject = !isHidden(oldPath) && !isHidden(newPath);
      const target = keepObject ? node : node instanceof TFile ? new TFile(newPath) : new TFolder(newPath);
      if (target instanceof TFile && node instanceof TFile) target.stat = { ...node.stat };
      if (keepObject) this.retarget(target, newPath);
      this.nodes.set(newPath, target);
      if (text !== undefined) this.texts.set(newPath, text);
      this.attach(target);
    }
  }

  private retarget(node: VaultNode, newPath: string): void {
    const probe = new TFile(newPath);
    node.path = newPath;
    node.name = probe.name;
    if (node instanceof TFile) {
      node.basename = probe.basename;
      node.extension = probe.extension;
    } else {
      node.children = [];
    }
  }
}

class FakeMetadataCache {
  private readonly listeners = new Map<string, Set<() => unknown>>();

  constructor(
    private readonly vault: FakeVault,
    private readonly unindexed: ReadonlySet<string>,
  ) {}

  // Parsed from the file's current text on every call, so it always reflects the latest write.
  // Unlike real Obsidian there is no indexing delay, except for files listed as unindexed.
  getFileCache(file: TFile): { frontmatter?: Record<string, unknown> } | null {
    if (file.extension !== "md" || this.unindexed.has(file.path) || !this.vault.has(file.path)) return null;
    const parts = splitFrontmatter(this.vault.textAt(file.path));
    if (!parts) return {};
    try {
      const parsed = parseYaml(parts.yaml);
      return isMapping(parsed) ? { frontmatter: parsed } : {};
    } catch {
      return {};
    }
  }

  // Links are case-insensitive. An exact path wins; otherwise the note in the source's own
  // folder, then the shortest path, then alphabetical order.
  getFirstLinkpathDest(linkpath: string, sourcePath: string): TFile | null {
    const wanted = [linkpath.toLowerCase(), `${linkpath.toLowerCase()}.md`];
    const sourceFolder = parentOf(sourcePath);
    const rank = (file: TFile): [number, number, number] => {
      const path = file.path.toLowerCase();
      return [wanted.includes(path) ? 0 : 1, parentOf(file.path) === sourceFolder ? 0 : 1, path.length];
    };
    const matches = this.vault.indexedFiles().filter((file) => {
      const path = file.path.toLowerCase();
      return wanted.some((w) => path === w || path.endsWith(`/${w}`));
    });
    matches.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
      return a.path.localeCompare(b.path);
    });
    return matches[0] ?? null;
  }

  on(name: string, callback: () => unknown, ctx?: unknown): { name: string; callback: () => unknown } {
    const bound = ctx === undefined ? callback : callback.bind(ctx);
    if (!this.listeners.has(name)) this.listeners.set(name, new Set());
    this.listeners.get(name)?.add(bound);
    return { name, callback: bound };
  }

  offref(ref: { name: string; callback: () => unknown }): void {
    this.listeners.get(ref.name)?.delete(ref.callback);
  }

  fireResolved(): void {
    for (const callback of [...(this.listeners.get("resolved") ?? [])]) callback();
  }
}

class FakeWorkspace {
  private readonly waiting: Array<() => unknown> = [];

  constructor(public layoutReady: boolean) {}

  // Like Obsidian: runs at once when the layout is ready, otherwise once it becomes ready.
  onLayoutReady(callback: () => unknown): void {
    if (this.layoutReady) callback();
    else this.waiting.push(callback);
  }

  fireLayoutReady(): void {
    this.layoutReady = true;
    for (const callback of this.waiting.splice(0)) callback();
  }
}

class FakeFileManager {
  constructor(private readonly vault: FakeVault) {}

  async processFrontMatter(file: TFile, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    const text = this.vault.textAt(file.path);
    const parts = splitFrontmatter(text);
    // Like Obsidian, broken YAML rejects instead of being overwritten.
    const parsed = parts ? parseYaml(parts.yaml) : null;
    if (parsed !== null && !isMapping(parsed)) throw new Error("Frontmatter is not a mapping");
    const frontmatter = parsed ?? {};
    fn(frontmatter);
    const yaml = Object.keys(frontmatter).length > 0 ? stringifyYaml(frontmatter) : "";
    if (parts) {
      this.vault.writeText(file, parts.opening + yaml + parts.closing + parts.body);
    } else if (yaml !== "") {
      this.vault.writeText(file, `---\n${yaml}---\n${text}`);
    }
  }

  renameFile(file: TFile | TFolder, newPath: string): Promise<void> {
    return this.vault.rename(file, newPath);
  }

  trashFile(file: TFile | TFolder): Promise<void> {
    return this.vault.trash(file);
  }
}

class FakeSecretStorage {
  private readonly secrets = new Map<string, string>();

  setSecret(id: string, secret: string): void {
    if (!SECRET_ID.test(id)) throw new Error(`Invalid secret id: ${id}`);
    this.secrets.set(id, secret);
  }

  getSecret(id: string): string | null {
    return this.secrets.get(id) ?? null;
  }

  listSecrets(): string[] {
    return [...this.secrets.keys()];
  }
}

export function createFakeApp(opts: FakeAppOptions = {}): FakeApp {
  const vault = new FakeVault(opts.files ?? {});
  const localStorage = new Map<string, string>();

  const app = {
    vault,
    metadataCache: new FakeMetadataCache(vault, new Set(opts.unindexed ?? [])),
    fileManager: new FakeFileManager(vault),
    workspace: new FakeWorkspace(opts.layoutReady ?? true),
    secretStorage: new FakeSecretStorage(),
    // Obsidian stores these as JSON strings in the browser's local storage.
    loadLocalStorage(key: string): unknown {
      const raw = localStorage.get(key);
      return raw === undefined ? null : (JSON.parse(raw) as unknown);
    },
    saveLocalStorage(key: string, data: unknown): void {
      if (data === null || data === undefined) localStorage.delete(key);
      else localStorage.set(key, JSON.stringify(data));
    },
    fileText: (path: string): string => vault.textAt(path),
    exists: (path: string): boolean => vault.has(path),
  };

  return app as unknown as FakeApp;
}
