import { SYNC_OFF_TEXT, statusText, type StatusAccount } from "../../src/ui/status";

// 2026-10-27 13:00 in Chicago (CDT, UTC-5).
const NOW = new Date("2026-10-27T18:00:00.000Z");

function account(changes: Partial<StatusAccount> = {}): StatusAccount {
  return { label: "Work", hasKey: true, ...changes };
}

describe("statusText", () => {
  it("shows last sync per account, errors, and missing keys", () => {
    const text = statusText(
      {
        a: account({ label: "Work", lastSuccessAt: "2026-10-27T15:42:00.000Z" }),
        b: account({ label: "Personal", failing: true, lastError: "auth", lastSuccessAt: "2026-10-27T15:00:00.000Z" }),
        c: account({ label: "Side", hasKey: false }),
      },
      undefined,
      NOW,
    );

    expect(text).toBe("Circleback: Work 10:42, Personal error, Side key needed on this device");
  });

  it("shows the time for a sync today and the date for an earlier day", () => {
    const text = statusText(
      {
        a: account({ label: "Work", lastSuccessAt: "2026-10-27T15:42:00.000Z" }),
        b: account({ label: "Personal", lastSuccessAt: "2026-10-25T20:00:00.000Z" }),
      },
      undefined,
      NOW,
    );

    expect(text).toBe("Circleback: Work 10:42, Personal Oct 25");
  });

  it("decides today by the local day, not the UTC day", () => {
    // 23:30 on Oct 27 in Chicago is already Oct 28 in UTC; the clock is 00:30 on Oct 28 locally.
    const lastSuccessAt = "2026-10-28T04:30:00.000Z";
    expect(statusText({ a: account({ lastSuccessAt }) }, undefined, new Date("2026-10-28T05:30:00.000Z"))).toBe(
      "Circleback: Work Oct 27",
    );
    // The same instant on the same local day shows the time.
    expect(statusText({ a: account({ lastSuccessAt }) }, undefined, new Date("2026-10-28T04:45:00.000Z"))).toBe(
      "Circleback: Work 23:30",
    );
    // Same UTC date, different local day.
    expect(statusText({ a: account({ lastSuccessAt }) }, undefined, new Date("2026-10-28T10:00:00.000Z"))).toBe(
      "Circleback: Work Oct 27",
    );
  });

  it("says an account that never synced has not synced yet", () => {
    expect(statusText({ a: account({ label: "Work" }) }, undefined, NOW)).toBe("Circleback: Work not synced yet");
    expect(statusText({ a: account({ lastSuccessAt: "not a date" }) }, undefined, NOW)).toBe(
      "Circleback: Work not synced yet",
    );
  });

  it("puts a missing key before an error", () => {
    expect(statusText({ a: account({ hasKey: false, failing: true }) }, undefined, NOW)).toBe(
      "Circleback: Work key needed on this device",
    );
  });

  it("shows full sync progress instead of the accounts", () => {
    const accounts = { a: account({ lastSuccessAt: "2026-10-27T15:42:00.000Z" }) };
    expect(statusText(accounts, { done: 120 }, NOW)).toBe("Circleback: full sync 120");
    expect(statusText(accounts, { done: 0 }, NOW)).toBe("Circleback: full sync 0");
  });

  it("is empty when there are no accounts", () => {
    expect(statusText({}, undefined, NOW)).toBe("");
  });

  it("keeps the order of the accounts it is given", () => {
    const text = statusText({ z: account({ label: "Zed", failing: true }), a: account({ label: "Abe", failing: true }) });
    expect(text).toBe("Circleback: Zed error, Abe error");
  });

  it("uses the current time when none is given", () => {
    const justNow = new Date().toISOString();
    expect(statusText({ a: account({ lastSuccessAt: justNow }) })).toMatch(/^Circleback: Work \d{2}:\d{2}$/);
  });
});

describe("SYNC_OFF_TEXT", () => {
  it("says sync is off on this device", () => {
    expect(SYNC_OFF_TEXT).toBe("Circleback: off on this device");
  });
});
