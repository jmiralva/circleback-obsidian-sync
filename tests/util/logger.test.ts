import { Logger, logger } from "../../src/util/logger";

type ConsoleMethod = "debug" | "info" | "log" | "warn" | "error";
const METHODS: ConsoleMethod[] = ["debug", "info", "log", "warn", "error"];

function spyOnConsole(): Record<ConsoleMethod, jest.SpyInstance> {
  const spies = {} as Record<ConsoleMethod, jest.SpyInstance>;
  for (const method of METHODS) spies[method] = jest.spyOn(console, method).mockImplementation(() => undefined);
  return spies;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("Logger: ring buffer", () => {
  it("dump returns one line per call, oldest first, with time, level and message", () => {
    const log = new Logger();
    log.info("first");
    log.warn("second");
    const lines = log.dump().split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO first$/);
    expect(lines[1]).toMatch(/Z WARN second$/);
  });

  it("is empty before anything is logged", () => {
    expect(new Logger().dump()).toBe("");
  });

  it("records every level, even with debug off", () => {
    const log = new Logger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    const lines = log.dump().split("\n");
    expect(lines.map((line) => line.split(" ")[1])).toEqual(["DEBUG", "INFO", "WARN", "ERROR"]);
  });

  it("keeps last 2000 lines", () => {
    const log = new Logger();
    for (let i = 0; i < 2005; i++) log.info(`line ${i}`);
    const lines = log.dump().split("\n");
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toMatch(/ line 5$/);
    expect(lines[1999]).toMatch(/ line 2004$/);
  });

  it("keeps exactly 2000 when it is filled to the brim", () => {
    const log = new Logger();
    for (let i = 0; i < 2000; i++) log.info(`line ${i}`);
    const lines = log.dump().split("\n");
    expect(lines).toHaveLength(2000);
    expect(lines[0]).toMatch(/ line 0$/);
  });

  it("keeps separate buffers per Logger", () => {
    const a = new Logger();
    const b = new Logger();
    a.info("only in a");
    expect(a.dump()).toContain("only in a");
    expect(b.dump()).toBe("");
  });

  it("exports a shared logger", () => {
    expect(logger).toBeInstanceOf(Logger);
  });
});

describe("Logger: extra data", () => {
  it("appends objects as JSON", () => {
    const log = new Logger();
    log.info("synced", { account: "Work", count: 3 });
    expect(log.dump()).toMatch(/ INFO synced \{"account":"Work","count":3\}$/);
  });

  it("appends strings as they are and several values in order", () => {
    const log = new Logger();
    log.warn("odd", "a", 2, null);
    expect(log.dump()).toMatch(/ WARN odd a 2 null$/);
  });

  it("writes an Error as its name and message, on one line", () => {
    const log = new Logger();
    log.error("failed", new TypeError("bad thing"));
    const dump = log.dump();
    expect(dump).toMatch(/ ERROR failed TypeError: bad thing$/);
    expect(dump.split("\n")).toHaveLength(1);
  });

  it("does not throw on values JSON cannot write", () => {
    const log = new Logger();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => {
      log.info("odd values", circular, undefined, BigInt(5), Symbol("s"));
    }).not.toThrow();
    expect(log.dump()).toMatch(/ INFO odd values .+ undefined 5 Symbol\(s\)$/);
  });
});

describe("Logger: redaction", () => {
  it("logger dump redacts api keys", () => {
    const log = new Logger();
    log.info("key cb_abc123");
    expect(log.dump()).toContain("cb_[redacted]");
    expect(log.dump()).not.toContain("cb_abc123");
  });

  it("redacts every key, including those with dashes and underscores, and those inside data", () => {
    const log = new Logger();
    log.error("auth failed for cb_A-b_9 and cb_second", { headers: { Authorization: "Bearer cb_Zz-99_x" } });
    const dump = log.dump();
    expect(dump).not.toMatch(/cb_[A-Za-z0-9]/);
    expect(dump.match(/cb_\[redacted\]/g)).toHaveLength(3);
    expect(dump).toContain("Bearer cb_[redacted]");
  });

  it("leaves the rest of the line alone", () => {
    const log = new Logger();
    log.info("key cb_abc123 was rejected (401)");
    expect(log.dump()).toMatch(/ INFO key cb_\[redacted\] was rejected \(401\)$/);
  });
});

describe("Logger: console", () => {
  it("stays silent unless debug is on", () => {
    const spies = spyOnConsole();
    const log = new Logger();
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    for (const method of METHODS) expect(spies[method]).not.toHaveBeenCalled();
  });

  // The Obsidian review lint allows only console.debug, console.warn and console.error.
  it("writes debug and info to console.debug, warn to console.warn, error to console.error", () => {
    const spies = spyOnConsole();
    const log = new Logger();
    log.setDebug(true);
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(spies.debug.mock.calls.map((call: [string]) => call[0])).toEqual([
      expect.stringMatching(/ DEBUG d$/),
      expect.stringMatching(/ INFO i$/),
    ]);
    expect(spies.warn.mock.calls).toEqual([[expect.stringMatching(/ WARN w$/)]]);
    expect(spies.error.mock.calls).toEqual([[expect.stringMatching(/ ERROR e$/)]]);
    expect(spies.info).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
  });

  it("stops writing when debug goes off again", () => {
    const spies = spyOnConsole();
    const log = new Logger();
    log.setDebug(true);
    log.info("on");
    log.setDebug(false);
    log.info("off");
    expect(spies.debug).toHaveBeenCalledTimes(1);
    expect(log.dump()).toContain("off");
  });

  it("never writes a key to the console either", () => {
    const spies = spyOnConsole();
    const log = new Logger();
    log.setDebug(true);
    log.info("key cb_abc123", { token: "cb_def456" });
    const printed = spies.debug.mock.calls.flat().join(" ");
    expect(printed).toContain("cb_[redacted]");
    expect(printed).not.toContain("cb_abc123");
    expect(printed).not.toContain("cb_def456");
  });

  it("starts with debug off", () => {
    const spies = spyOnConsole();
    new Logger().info("quiet");
    for (const method of METHODS) expect(spies[method]).not.toHaveBeenCalled();
  });
});
