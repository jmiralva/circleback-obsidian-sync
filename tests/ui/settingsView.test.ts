import { CirclebackError } from "../../src/api/errors";
import type { ConnectionInfo } from "../../src/api/schemas";
import { DEFAULT_SETTINGS } from "../../src/settings/types";
import type { CirclebackSyncSettings } from "../../src/settings/types";
import {
  KEY_PLACEHOLDER,
  KEY_STORED_PLACEHOLDER,
  NO_KEY_TO_TEST,
  REMOVE_ACCOUNT_TEXT,
  UNNAMED_ACCOUNT,
  accountStatusLine,
  accountTitle,
  checkConnection,
  fullSyncButtonText,
  fullSyncDescription,
  keyRowView,
  removeAccountTitle,
  settingsVisibility,
} from "../../src/ui/settingsView";
import { logger } from "../../src/util/logger";

function settings(changes: Partial<CirclebackSyncSettings> = {}): CirclebackSyncSettings {
  return { ...DEFAULT_SETTINGS, ...changes };
}

describe("accountStatusLine", () => {
  it("says a key is needed when this device has none, whatever else is known", () => {
    expect(accountStatusLine(false, {})).toBe("Key needed on this device");
    expect(accountStatusLine(false, { failing: true, lastError: "auth", lastSuccessAt: "2026-10-27T15:00:00.000Z" })).toBe(
      "Key needed on this device",
    );
  });

  it("says why an account stopped syncing", () => {
    expect(accountStatusLine(true, { failing: true, lastError: "auth" })).toBe(
      "Stopped syncing because the API key was not accepted",
    );
    expect(accountStatusLine(true, { failing: true, lastError: "rate-limited" })).toBe(
      "Stopped syncing because Circleback's rate limit was reached",
    );
  });

  it("falls back to an unexpected error for a missing or unknown reason", () => {
    expect(accountStatusLine(true, { failing: true })).toBe("Stopped syncing because of an unexpected error");
    expect(accountStatusLine(true, { failing: true, lastError: "toString" })).toBe(
      "Stopped syncing because of an unexpected error",
    );
  });

  it("shows the last successful sync in local time", () => {
    // 15:42 UTC is 10:42 in Chicago (CDT).
    expect(accountStatusLine(true, { lastSuccessAt: "2026-10-27T15:42:00.000Z" })).toBe("Last synced Oct 27, 10:42");
    // A failure that has cleared (failing false) shows the sync time again.
    expect(accountStatusLine(true, { failing: false, lastError: undefined, lastSuccessAt: "2026-01-05T03:07:00.000Z" })).toBe(
      "Last synced Jan 4, 21:07",
    );
  });

  it("says not synced yet when there is no time, or one that cannot be read", () => {
    expect(accountStatusLine(true, {})).toBe("Not synced yet");
    expect(accountStatusLine(true, { lastSuccessAt: "yesterday" })).toBe("Not synced yet");
  });
});

describe("checkConnection", () => {
  function clientFor(result: ConnectionInfo | Error): jest.Mock {
    const testConnection = jest.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
    return jest.fn(() => ({ testConnection }));
  }

  it("asks for a key first, without calling the API", async () => {
    const factory = clientFor({ email: "jo@example.com" });

    const outcome = await checkConnection(null, factory);

    expect(outcome).toEqual({ text: NO_KEY_TO_TEST });
    expect(NO_KEY_TO_TEST).toBe("Enter an API key first.");
    expect(factory).not.toHaveBeenCalled();
  });

  it("shows the email and the key name, and returns the email to cache", async () => {
    const factory = clientFor({ email: "jo@example.com", apiKeyName: "Obsidian" });

    const outcome = await checkConnection("cb_key", factory);

    expect(factory).toHaveBeenCalledWith("cb_key");
    expect(outcome).toEqual({ text: 'Connected as jo@example.com with key "Obsidian"', email: "jo@example.com" });
  });

  it("leaves out the key name when there is none", async () => {
    const outcome = await checkConnection("cb_key", clientFor({ email: "jo@example.com" }));

    expect(outcome).toEqual({ text: "Connected as jo@example.com", email: "jo@example.com" });
  });

  it("names the reason a Circleback error gives, and caches no email", async () => {
    const outcome = await checkConnection("cb_key", clientFor(new CirclebackError("auth", "bad key", 401)));

    expect(outcome).toEqual({ text: "Could not connect because the API key was not accepted." });
  });

  it("calls any other failure unexpected", async () => {
    const outcome = await checkConnection("cb_key", clientFor(new TypeError("boom")));

    expect(outcome).toEqual({ text: "Could not connect because of an unexpected error." });
  });

  it("also covers a client that fails while it is being built", async () => {
    const outcome = await checkConnection("cb_key", () => {
      throw new Error("no client");
    });

    expect(outcome).toEqual({ text: "Could not connect because of an unexpected error." });
  });
});

describe("checkConnection logging", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("logs the error that made a test fail, so Copy logs has the detail", async () => {
    const warn = jest.spyOn(logger, "warn");
    const error = new CirclebackError("rate-limited", "Too many requests", 429);

    await checkConnection("cb_key", () => ({ testConnection: () => Promise.reject(error) }));

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("Test connection failed.", error);
  });

  it("logs an unexpected error too, and never lets a key into the log", async () => {
    const warn = jest.spyOn(logger, "warn");

    await checkConnection("cb_secret_key", () => ({
      testConnection: () => Promise.reject(new Error("failed with cb_secret_key")),
    }));

    expect(warn).toHaveBeenCalledWith("Test connection failed.", expect.any(Error));
    expect(logger.dump()).toContain("Test connection failed.");
    expect(logger.dump()).not.toContain("cb_secret_key");
  });

  it("logs nothing when the test works or there is no key", async () => {
    const warn = jest.spyOn(logger, "warn");

    await checkConnection("cb_key", () => ({ testConnection: () => Promise.resolve({ email: "jo@example.com" }) }));
    await checkConnection(null, () => ({ testConnection: () => Promise.resolve({ email: "jo@example.com" }) }));

    expect(warn).not.toHaveBeenCalled();
  });
});

describe("keyRowView", () => {
  it("offers to paste a key, and no way to clear one, when this device has none", () => {
    expect(keyRowView(false, {})).toEqual({
      status: "Key needed on this device",
      placeholder: KEY_PLACEHOLDER,
      canClear: false,
    });
    expect(KEY_PLACEHOLDER).toBe("Paste your Circleback API key");
  });

  it("says a key is stored, and offers to clear it, when this device has one", () => {
    expect(keyRowView(true, { lastSuccessAt: "2026-10-27T15:42:00.000Z" })).toEqual({
      status: "Last synced Oct 27, 10:42",
      placeholder: KEY_STORED_PLACEHOLDER,
      canClear: true,
    });
    expect(KEY_STORED_PLACEHOLDER).toBe("Stored on this device");
  });

  it("shows why an account stopped, when it has a key", () => {
    expect(keyRowView(true, { failing: true, lastError: "auth" }).status).toBe(
      "Stopped syncing because the API key was not accepted",
    );
  });
});

describe("removing an account", () => {
  it("tells the user it is removed on every device that shares the vault", () => {
    expect(REMOVE_ACCOUNT_TEXT).toBe(
      "Removes the account on every device that shares this vault, and its API key from this device. Its notes stay in the vault.",
    );
  });

  it("asks about the account by its label", () => {
    expect(removeAccountTitle("Work")).toBe('Remove "Work"?');
    expect(removeAccountTitle('The "big" one')).toBe('Remove "The "big" one"?');
  });
});

describe("accountTitle", () => {
  it("is the account's label", () => {
    expect(accountTitle("Work")).toBe("Work");
  });

  it("stands in for a label that is empty or only spaces", () => {
    expect(UNNAMED_ACCOUNT).toBe("Unnamed account");
    expect(accountTitle("")).toBe("Unnamed account");
    expect(accountTitle("   ")).toBe("Unnamed account");
  });
});

describe("fullSyncButtonText", () => {
  it("offers to cancel a full sync that is running and to start one otherwise", () => {
    expect(fullSyncButtonText(true)).toBe("Cancel full sync");
    expect(fullSyncButtonText(false)).toBe("Start full sync");
  });
});

describe("fullSyncDescription", () => {
  const BASE =
    "Rewrites every synced note from your whole Circleback history, not only the sync window. Edits to the text of a synced note are replaced; frontmatter fields the plugin does not own are kept.";
  const EXTRA = " It can also create a daily note for every past meeting day that lacks one.";

  it("is just the base text with daily notes off", () => {
    expect(fullSyncDescription(settings())).toBe(BASE);
  });

  it("adds the daily note sentence when daily notes are always created and linked", () => {
    expect(fullSyncDescription(settings({ linkFromDailyNotes: true, createMissingDailyNotes: "always" }))).toBe(BASE + EXTRA);
  });

  it("adds it for sections too, which always write to daily notes", () => {
    expect(fullSyncDescription(settings({ saveAs: "sections", createMissingDailyNotes: "always" }))).toBe(BASE + EXTRA);
  });

  it("leaves it out when daily notes are not always created", () => {
    expect(fullSyncDescription(settings({ saveAs: "sections", createMissingDailyNotes: "today" }))).toBe(BASE);
    expect(fullSyncDescription(settings({ linkFromDailyNotes: true, createMissingDailyNotes: "never" }))).toBe(BASE);
  });

  it("leaves it out when nothing links to daily notes, even if always is chosen", () => {
    expect(fullSyncDescription(settings({ saveAs: "files", linkFromDailyNotes: false, createMissingDailyNotes: "always" }))).toBe(BASE);
  });
});

describe("settingsVisibility", () => {
  it("shows only the keyword for an active title filter", () => {
    expect(settingsVisibility(settings({ titleFilterMode: "disabled" })).titleKeyword).toBe(false);
    expect(settingsVisibility(settings({ titleFilterMode: "include" })).titleKeyword).toBe(true);
    expect(settingsVisibility(settings({ titleFilterMode: "exclude" })).titleKeyword).toBe(true);
  });

  it("shows the transcript group only when transcripts are synced", () => {
    expect(settingsVisibility(settings({ syncTranscripts: false })).transcripts).toBe(false);
    expect(settingsVisibility(settings({ syncTranscripts: true })).transcripts).toBe(true);
  });

  describe("notes, in files mode", () => {
    it("shows the file settings and not the section heading", () => {
      const show = settingsVisibility(settings({ saveAs: "files" }));

      expect(show.fileSettings).toBe(true);
      expect(show.sectionHeading).toBe(false);
    });

    it("shows the custom base folder only for a custom base folder", () => {
      expect(settingsVisibility(settings({ baseFolderType: "custom" })).customBaseFolder).toBe(true);
      expect(settingsVisibility(settings({ baseFolderType: "daily-notes" })).customBaseFolder).toBe(false);
    });

    it("shows the custom subfolder pattern only for the custom pattern", () => {
      expect(settingsVisibility(settings({ subfolderPattern: "custom" })).customSubfolder).toBe(true);
      expect(settingsVisibility(settings({ subfolderPattern: "month" })).customSubfolder).toBe(false);
    });

    it("shows the link heading and daily note creation only when linking", () => {
      const linking = settingsVisibility(settings({ linkFromDailyNotes: true }));
      const notLinking = settingsVisibility(settings({ linkFromDailyNotes: false }));

      expect(linking.linkHeading).toBe(true);
      expect(linking.createMissingDailyNotes).toBe(true);
      expect(notLinking.linkHeading).toBe(false);
      expect(notLinking.createMissingDailyNotes).toBe(false);
    });
  });

  describe("notes, in sections mode", () => {
    const sections = settings({ saveAs: "sections", customSubfolderPattern: "x", subfolderPattern: "custom", linkFromDailyNotes: true });

    it("shows the section heading and daily note creation, and none of the file settings", () => {
      const show = settingsVisibility(sections);

      expect(show.sectionHeading).toBe(true);
      expect(show.createMissingDailyNotes).toBe(true);
      expect(show.fileSettings).toBe(false);
      expect(show.customBaseFolder).toBe(false);
      expect(show.customSubfolder).toBe(false);
      expect(show.linkHeading).toBe(false);
    });
  });

  describe("transcripts", () => {
    it("shows the folder settings only for a custom location", () => {
      const custom = settingsVisibility(settings({ syncTranscripts: true, transcriptHandling: "custom-location" }));
      const same = settingsVisibility(settings({ syncTranscripts: true, transcriptHandling: "same-location" }));
      const combined = settingsVisibility(settings({ syncTranscripts: true, transcriptHandling: "combined" }));

      expect(custom.transcriptFolder).toBe(true);
      expect(same.transcriptFolder).toBe(false);
      expect(combined.transcriptFolder).toBe(false);
    });

    it("shows the custom transcript pattern only for a custom location with the custom pattern", () => {
      const base = { syncTranscripts: true, transcriptSubfolderPattern: "custom" as const };

      expect(settingsVisibility(settings({ ...base, transcriptHandling: "custom-location" })).transcriptCustomSubfolder).toBe(true);
      expect(settingsVisibility(settings({ ...base, transcriptHandling: "same-location" })).transcriptCustomSubfolder).toBe(false);
      expect(
        settingsVisibility(settings({ syncTranscripts: true, transcriptHandling: "custom-location", transcriptSubfolderPattern: "day" }))
          .transcriptCustomSubfolder,
      ).toBe(false);
    });

    it("shows the filename pattern for everything except combined", () => {
      const show = (transcriptHandling: CirclebackSyncSettings["transcriptHandling"]): boolean =>
        settingsVisibility(settings({ syncTranscripts: true, transcriptHandling })).transcriptFilename;

      expect(show("custom-location")).toBe(true);
      expect(show("same-location")).toBe(true);
      expect(show("combined")).toBe(false);
    });

    it("shows nothing about transcripts while they are off", () => {
      const show = settingsVisibility(settings({ syncTranscripts: false, transcriptHandling: "custom-location" }));

      expect(show.transcriptFolder).toBe(false);
      expect(show.transcriptFilename).toBe(false);
    });
  });
});
