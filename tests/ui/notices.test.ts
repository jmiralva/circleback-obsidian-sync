import { duplicateNotice, reasonText, resultNotice, transitionNotices } from "../../src/ui/notices";
import type { AccountErrorKind, AccountResult, RunResult } from "../../src/sync/syncEngine";

function account(changes: Partial<AccountResult> = {}): AccountResult {
  return { ok: true, written: 0, skipped: 0, failed: 0, ...changes };
}

function result(perAccount: Record<string, AccountResult>): RunResult {
  return { perAccount, duplicates: [] };
}

describe("transitionNotices", () => {
  it("notice fires only on ok->failing and failing->ok", () => {
    // ok to ok, failing to failing: nothing.
    expect(transitionNotices({ failing: false }, { ok: true }, "Work")).toBeNull();
    expect(transitionNotices({}, { ok: true }, "Work")).toBeNull();
    expect(transitionNotices({ failing: true }, { ok: false, error: "auth" }, "Work")).toBeNull();

    // ok to failing, and failing to ok.
    expect(transitionNotices({ failing: false }, { ok: false, error: "auth" }, "Work")).toBe(
      'Circleback Sync: "Work" stopped syncing because the API key was not accepted. Check its API key in the plugin settings.',
    );
    expect(transitionNotices({ failing: true }, { ok: true }, "Work")).toBe('Circleback Sync: "Work" is syncing again.');
  });

  it("counts an account that has never run as ok, so a first run that fails is reported", () => {
    expect(transitionNotices({}, { ok: false, error: "network" }, "Work")).toBe(
      'Circleback Sync: "Work" stopped syncing because there was no connection to Circleback. It will try again at the next sync.',
    );
  });

  it("adds the hint that fits the reason", () => {
    const notice = (error: AccountErrorKind): string | null => transitionNotices({}, { ok: false, error }, "Work");

    expect(notice("invalid-response")).toBe(
      'Circleback Sync: "Work" stopped syncing because Circleback sent data this plugin version does not understand. Check for a plugin update.',
    );
    expect(notice("unexpected")).toBe(
      'Circleback Sync: "Work" stopped syncing because of an unexpected error. Use "Copy logs" in the plugin settings for details.',
    );
    for (const kind of ["forbidden", "rate-limited", "timeout", "network", "server"] as const) {
      expect(notice(kind)).toMatch(/ It will try again at the next sync\.$/);
    }
  });

  it("treats a failure with no error kind as unexpected", () => {
    expect(transitionNotices({}, { ok: false }, "Work")).toContain("because of an unexpected error");
  });

  it("uses the label it is given", () => {
    expect(transitionNotices({ failing: true }, { ok: true }, "Personal")).toBe(
      'Circleback Sync: "Personal" is syncing again.',
    );
  });
});

describe("reasonText", () => {
  it("has a sentence for every kind", () => {
    expect(reasonText("auth")).toBe("the API key was not accepted");
    expect(reasonText("forbidden")).toBe("Circleback refused access");
    expect(reasonText("rate-limited")).toBe("Circleback's rate limit was reached");
    expect(reasonText("timeout")).toBe("Circleback did not answer in time");
    expect(reasonText("network")).toBe("there was no connection to Circleback");
    expect(reasonText("server")).toBe("Circleback had a server error");
    expect(reasonText("invalid-response")).toBe("Circleback sent data this plugin version does not understand");
    expect(reasonText("unexpected")).toBe("of an unexpected error");
  });
});

describe("duplicateNotice", () => {
  it("duplicate notice fires only when the count grows", () => {
    expect(duplicateNotice(0, 0)).toBeNull();
    expect(duplicateNotice(2, 2)).toBeNull();
    expect(duplicateNotice(3, 1)).toBeNull();
    expect(duplicateNotice(0, 3)).toBe("Circleback Sync found 3 meetings with duplicate notes. See the plugin settings.");
    expect(duplicateNotice(2, 3)).toBe("Circleback Sync found 3 meetings with duplicate notes. See the plugin settings.");
  });

  it("says meeting, not meetings, for one", () => {
    expect(duplicateNotice(0, 1)).toBe("Circleback Sync found 1 meeting with duplicate notes. See the plugin settings.");
  });
});

describe("resultNotice", () => {
  const auto = { manual: false, fullSync: false, show: true };
  const manual = { manual: true, fullSync: false, show: true };
  const full = { manual: true, fullSync: true, show: true };

  it("counts the meetings written across accounts", () => {
    const run = result({ a: account({ written: 2 }), b: account({ written: 3 }) });
    expect(resultNotice(run, auto)).toBe("Circleback Sync: 5 meetings updated.");
    expect(resultNotice(result({ a: account({ written: 1 }) }), auto)).toBe("Circleback Sync: 1 meeting updated.");
  });

  it("says everything is up to date when nothing was written, for a manual sync", () => {
    expect(resultNotice(result({ a: account({ skipped: 4 }) }), manual)).toBe("Circleback Sync: everything is up to date.");
    expect(resultNotice(result({}), manual)).toBe("Circleback Sync: everything is up to date.");
  });

  it("mentions meetings that could not be written, and accounts that could not sync", () => {
    const run = result({
      a: account({ written: 1, failed: 2 }),
      b: account({ ok: false, error: "auth" }),
      c: account({ ok: false, error: "network" }),
    });
    expect(resultNotice(run, manual)).toBe(
      'Circleback Sync: 1 meeting updated. 2 could not be written; use "Copy logs" in the plugin settings for details. 2 accounts could not sync; see the status bar.',
    );
    expect(resultNotice(result({ a: account({ ok: false, error: "auth" }) }), manual)).toBe(
      "Circleback Sync: everything is up to date. 1 account could not sync; see the status bar.",
    );
  });

  it("stays quiet on an automatic sync unless notifications are on and something was written or failed", () => {
    expect(resultNotice(result({ a: account({ skipped: 3 }) }), auto)).toBeNull();
    expect(resultNotice(result({ a: account({ written: 1 }) }), { ...auto, show: false })).toBeNull();
    expect(resultNotice(result({ a: account({ failed: 1 }) }), { ...auto, show: false })).toBeNull();
    expect(resultNotice(result({ a: account({ failed: 1 }) }), auto)).toBe(
      'Circleback Sync: everything is up to date. 1 could not be written; use "Copy logs" in the plugin settings for details.',
    );
    // An account that failed to sync is reported by the transition notice, not by this one.
    expect(resultNotice(result({ a: account({ ok: false, error: "auth" }) }), auto)).toBeNull();
  });

  it("always tells the user about a manual sync, whatever the setting says", () => {
    expect(resultNotice(result({ a: account({ written: 1 }) }), { ...manual, show: false })).toBe(
      "Circleback Sync: 1 meeting updated.",
    );
    expect(resultNotice(result({}), { ...manual, show: false })).toBe("Circleback Sync: everything is up to date.");
  });

  it("reports a full sync as finished, always", () => {
    expect(resultNotice(result({ a: account({ written: 12 }) }), { ...full, show: false })).toBe(
      "Circleback Sync: full sync finished. 12 meetings updated.",
    );
    expect(resultNotice(result({ a: account({ written: 1 }) }), full)).toBe(
      "Circleback Sync: full sync finished. 1 meeting updated.",
    );
    expect(resultNotice(result({ a: account({}) }), full)).toBe("Circleback Sync: full sync finished. 0 meetings updated.");
    expect(resultNotice(result({ a: account({ written: 2, failed: 1 }) }), full)).toBe(
      'Circleback Sync: full sync finished. 2 meetings updated. 1 could not be written; use "Copy logs" in the plugin settings for details.',
    );
  });
});
