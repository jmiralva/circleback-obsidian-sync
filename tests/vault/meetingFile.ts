// Builds the text of a vault file the way the plugin writes one, for the vault tests.
import { stringifyYaml } from "obsidian";
import type { FileKind } from "../../src/format/fields";
import { hashBody } from "../../src/util/hash";

/** "---\n<frontmatter>---\n<body>", with the frontmatter written by the same YAML library the fake app reads with. */
export function fileText(frontmatter: Record<string, unknown>, body: string): string {
  return `---\n${stringifyYaml(frontmatter)}---\n${body}`;
}

export interface PluginFileOptions {
  id?: string;
  kind?: FileKind;
  /** `null` leaves `circleback_first_synced` out. */
  firstSynced?: string | null;
  body?: string;
  /** Written as `circleback_hash`. Defaults to the hash of `body`, which is an untouched file. */
  hash?: string;
  /** Extra frontmatter, such as a field the user added. */
  extra?: Record<string, unknown>;
}

/** A file exactly as the plugin leaves it: the plugin's keys only, and a hash that matches the body. */
export function pluginFile(opts: PluginFileOptions = {}): string {
  const { id = "m1", kind = "note", body = "# Meeting\n\nNotes.\n", extra = {} } = opts;
  const frontmatter: Record<string, unknown> = {
    title: "Meeting",
    created: "2026-10-20T09:00:00.000Z",
    type: kind === "transcript" ? "transcript" : "note",
    circleback_id: id,
    circleback_kind: kind,
    circleback_account: "Work",
    circleback_updated: "2026-10-20T10:00:00.000Z",
    circleback_hash: opts.hash ?? hashBody(body),
    circleback_url: `https://circleback.ai/meetings/${id}`,
  };
  const firstSynced = opts.firstSynced === undefined ? "2026-10-20T10:00:00.000Z" : opts.firstSynced;
  if (firstSynced !== null) frontmatter.circleback_first_synced = firstSynced;
  return fileText({ ...frontmatter, ...extra }, body);
}
