import { DEFAULT_SETTINGS } from "../../src/settings/types";
import type { AccountConfig, CirclebackSyncSettings } from "../../src/settings/types";
import {
  addAccount,
  parseWholeNumber,
  removeAccount,
  trimFolder,
  updateAccount,
  withField,
} from "../../src/ui/settingsEdits";

function account(id: string, label = id, selfNameOverride = ""): AccountConfig {
  return { id, label, selfNameOverride };
}

function settingsWith(accounts: AccountConfig[], changes: Partial<CirclebackSyncSettings> = {}): CirclebackSyncSettings {
  return { ...DEFAULT_SETTINGS, accounts, ...changes };
}

describe("addAccount", () => {
  it("appends an account labelled Account 1 with no name override", () => {
    const next = addAccount(settingsWith([]), "0f8b-1");

    expect(next.accounts).toEqual([{ id: "0f8b-1", label: "Account 1", selfNameOverride: "" }]);
  });

  it("turns periodic sync on for the first account", () => {
    expect(addAccount(settingsWith([]), "a").periodicSync).toBe(true);
  });

  it("leaves periodic sync alone when an account already exists", () => {
    const off = settingsWith([account("a", "Work")], { periodicSync: false });
    const on = settingsWith([account("a", "Work")], { periodicSync: true });

    expect(addAccount(off, "b").periodicSync).toBe(false);
    expect(addAccount(on, "b").periodicSync).toBe(true);
  });

  it("numbers the label by the count of accounts, plus one", () => {
    const next = addAccount(settingsWith([account("a", "Work"), account("b", "Home")]), "c");

    expect(next.accounts[2].label).toBe("Account 3");
  });

  it("raises the number until no account has that label", () => {
    // One account, so n starts at 2; "Account 2" and "Account 3" are taken.
    const next = addAccount(settingsWith([account("a", "Account 2")]), "b");
    expect(next.accounts[1].label).toBe("Account 3");

    const more = addAccount(settingsWith([account("a", "Account 2"), account("b", "Account 3"), account("c", "Account 4")]), "d");
    expect(more.accounts[3].label).toBe("Account 5");
  });

  it("keeps the other accounts and settings", () => {
    const before = settingsWith([account("a", "Work", "Jo")], { syncDaysBack: 14 });

    const next = addAccount(before, "b");

    expect(next.accounts[0]).toEqual(account("a", "Work", "Jo"));
    expect(next.syncDaysBack).toBe(14);
  });

  it("does not change the settings it was given", () => {
    const before = settingsWith([]);

    addAccount(before, "a");

    expect(before.accounts).toEqual([]);
    expect(before.periodicSync).toBe(false);
  });
});

describe("removeAccount", () => {
  it("removes the account with that id and keeps the rest in order", () => {
    const before = settingsWith([account("a"), account("b"), account("c")]);

    expect(removeAccount(before, "b").accounts.map((a) => a.id)).toEqual(["a", "c"]);
  });

  it("changes nothing for an id that is not there", () => {
    const before = settingsWith([account("a")]);

    expect(removeAccount(before, "zzz").accounts).toEqual(before.accounts);
  });

  it("does not change the settings it was given", () => {
    const before = settingsWith([account("a"), account("b")]);

    removeAccount(before, "a");

    expect(before.accounts).toHaveLength(2);
  });

  it("leaves periodic sync as it was when the last account goes", () => {
    const before = settingsWith([account("a")], { periodicSync: true });

    expect(removeAccount(before, "a").periodicSync).toBe(true);
  });
});

describe("updateAccount", () => {
  it("changes the given fields of one account only", () => {
    const before = settingsWith([account("a", "Work"), account("b", "Home")]);

    const next = updateAccount(before, "b", { selfNameOverride: "Jo" });

    expect(next.accounts).toEqual([account("a", "Work"), account("b", "Home", "Jo")]);
  });

  it("changes nothing for an id that is not there", () => {
    const before = settingsWith([account("a", "Work")]);

    expect(updateAccount(before, "gone", { label: "X" }).accounts).toEqual(before.accounts);
  });

  it("does not change the settings it was given", () => {
    const before = settingsWith([account("a", "Work")]);

    updateAccount(before, "a", { label: "Other" });

    expect(before.accounts[0].label).toBe("Work");
  });
});

describe("withField", () => {
  it("returns a copy with one field changed", () => {
    const before = settingsWith([]);

    const next = withField(before, "syncDaysBack", 30);

    expect(next.syncDaysBack).toBe(30);
    expect(before.syncDaysBack).toBe(7);
    expect(next).not.toBe(before);
  });
});

describe("parseWholeNumber", () => {
  it("reads digits, with surrounding spaces ignored", () => {
    expect(parseWholeNumber("30", 1, 1440)).toBe(30);
    expect(parseWholeNumber("  45 ", 1, 1440)).toBe(45);
    expect(parseWholeNumber("007", 1, 1440)).toBe(7);
  });

  it("accepts the limits themselves", () => {
    expect(parseWholeNumber("1", 1, 1440)).toBe(1);
    expect(parseWholeNumber("1440", 1, 1440)).toBe(1440);
    expect(parseWholeNumber("0", 0, 1440)).toBe(0);
  });

  it("gives null outside the limits", () => {
    expect(parseWholeNumber("0", 1, 1440)).toBeNull();
    expect(parseWholeNumber("1441", 1, 1440)).toBeNull();
    expect(parseWholeNumber("99999999999999999999999", 1, 1440)).toBeNull();
  });

  it("gives null for anything that is not plain digits", () => {
    for (const text of ["", "   ", "abc", "3.5", "-5", "+5", "1e3", "1,000", "12 34", "0x10", "٣٠"]) {
      expect(parseWholeNumber(text, 0, 5000)).toBeNull();
    }
  });
});

describe("trimFolder", () => {
  it("drops spaces and slashes at both ends", () => {
    expect(trimFolder("  /Circleback/Notes/ ")).toBe("Circleback/Notes");
    expect(trimFolder("//Circleback//")).toBe("Circleback");
  });

  it("leaves slashes inside the path", () => {
    expect(trimFolder("Work/Meetings/2026")).toBe("Work/Meetings/2026");
  });

  it("turns slashes and spaces alone into an empty path", () => {
    expect(trimFolder("/")).toBe("");
    expect(trimFolder(" / / ")).toBe("");
    expect(trimFolder("")).toBe("");
  });
});
