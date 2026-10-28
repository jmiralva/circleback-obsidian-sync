import { CirclebackError } from "../../src/api/errors";
import type { ConnectionInfo } from "../../src/api/schemas";
import { KeyStore } from "../../src/secrets/keyStore";
import { DeviceState } from "../../src/state/deviceState";
import { clearKey, commitKey, testKey } from "../../src/ui/accountKeys";
import { NO_KEY_TO_TEST } from "../../src/ui/settingsView";
import { logger } from "../../src/util/logger";
import { createFakeApp } from "../harness/fakeApp";

function setup(): { keys: KeyStore; device: DeviceState } {
  const app = createFakeApp();
  return { keys: new KeyStore(app), device: new DeviceState(app) };
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe("commitKey", () => {
  it("stores the key without the spaces around it", () => {
    const { keys, device } = setup();

    const result = commitKey({ keys, device }, "a", "  cb_abc123\n");

    expect(result).toEqual({ ok: true, hasKey: true });
    expect(keys.get("a")).toBe("cb_abc123");
  });

  it("forgets the owner of the old key and keeps the rest of the device state", () => {
    const { keys, device } = setup();
    device.update("a", { ownerEmail: "old@example.com", ownerName: "Old", lastSuccessAt: "2026-10-27T15:00:00.000Z" });

    commitKey({ keys, device }, "a", "cb_new");

    expect(device.account("a")).toEqual({ lastSuccessAt: "2026-10-27T15:00:00.000Z" });
  });

  it("clears the stored key when the text is empty or only spaces", () => {
    const { keys, device } = setup();
    keys.set("a", "cb_old");

    const result = commitKey({ keys, device }, "a", "   ");

    expect(result).toEqual({ ok: true, hasKey: false });
    expect(keys.get("a")).toBeNull();
  });

  it("touches only the account it was given", () => {
    const { keys, device } = setup();
    keys.set("b", "cb_other");
    device.update("b", { ownerEmail: "b@example.com" });

    commitKey({ keys, device }, "a", "cb_a");

    expect(keys.get("b")).toBe("cb_other");
    expect(device.account("b").ownerEmail).toBe("b@example.com");
  });

  it("logs a failure and reports it, without storing, forgetting the owner, or logging the key", () => {
    const { keys, device } = setup();
    device.update("a", { ownerEmail: "keep@example.com" });
    const error = jest.spyOn(logger, "error");
    jest.spyOn(keys, "set").mockImplementation(() => {
      throw new Error("keychain locked");
    });

    const result = commitKey({ keys, device }, "a", "cb_secret_value");

    expect(result).toEqual({ ok: false });
    expect(error).toHaveBeenCalledWith("Could not save the API key.", expect.any(Error));
    expect(JSON.stringify(error.mock.calls)).not.toContain("cb_secret_value");
    expect(device.account("a").ownerEmail).toBe("keep@example.com");
  });

  it("reports a failure to clear in the same way", () => {
    const { keys, device } = setup();
    jest.spyOn(keys, "clear").mockImplementation(() => {
      throw new Error("keychain locked");
    });

    expect(commitKey({ keys, device }, "a", "")).toEqual({ ok: false });
  });
});

describe("clearKey", () => {
  it("removes the key from this device and forgets its owner", () => {
    const { keys, device } = setup();
    keys.set("a", "cb_old");
    device.update("a", { ownerEmail: "old@example.com", ownerName: "Old", failing: true, lastError: "auth" });

    const result = clearKey({ keys, device }, "a");

    expect(result).toEqual({ ok: true, hasKey: false });
    expect(keys.get("a")).toBeNull();
    expect(device.account("a")).toEqual({ failing: true, lastError: "auth" });
  });

  it("reports a failure", () => {
    const { keys, device } = setup();
    jest.spyOn(keys, "clear").mockImplementation(() => {
      throw new Error("keychain locked");
    });

    expect(clearKey({ keys, device }, "a")).toEqual({ ok: false });
  });
});

describe("testKey", () => {
  const INFO: ConnectionInfo = { email: "jo@example.com", apiKeyName: "Obsidian" };

  function clientFor(test: () => Promise<ConnectionInfo>): jest.Mock {
    return jest.fn(() => ({ testConnection: test }));
  }

  it("asks for a key when there is none, without calling the API", async () => {
    const { keys, device } = setup();
    const factory = clientFor(() => Promise.resolve(INFO));

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => true);

    expect(text).toBe(NO_KEY_TO_TEST);
    expect(factory).not.toHaveBeenCalled();
  });

  it("shows who the key belongs to and remembers the email", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_key");
    const factory = clientFor(() => Promise.resolve(INFO));

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => true);

    expect(factory).toHaveBeenCalledWith("cb_key");
    expect(text).toBe('Connected as jo@example.com with key "Obsidian"');
    expect(device.account("a").ownerEmail).toBe("jo@example.com");
  });

  it("says why it failed and remembers no email", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_key");
    jest.spyOn(logger, "warn");
    const factory = clientFor(() => Promise.reject(new CirclebackError("auth", "bad key", 401)));

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => true);

    expect(text).toBe("Could not connect because the API key was not accepted.");
    expect(device.account("a").ownerEmail).toBeUndefined();
  });

  it("drops the result when the key was changed while the test ran", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_old");
    const factory = clientFor(async () => {
      // The user pastes another key while the old one is being tested.
      commitKey({ keys, device }, "a", "cb_new");
      return INFO;
    });

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => true);

    expect(text).toBeNull();
    expect(device.account("a").ownerEmail).toBeUndefined();
  });

  it("drops the result when the key was cleared while the test ran", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_old");
    const factory = clientFor(async () => {
      clearKey({ keys, device }, "a");
      return INFO;
    });

    expect(await testKey({ keys, device, clientFor: factory }, "a", () => true)).toBeNull();
    expect(device.account("a").ownerEmail).toBeUndefined();
  });

  it("drops the result when the tab closed while the test ran", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_key");
    let open = true;
    const factory = clientFor(async () => {
      open = false;
      return INFO;
    });

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => open);

    expect(text).toBeNull();
    expect(device.account("a").ownerEmail).toBeUndefined();
  });

  it("drops a failure too when it is out of date", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_old");
    const factory = clientFor(async () => {
      keys.set("a", "cb_new");
      throw new CirclebackError("auth", "bad key", 401);
    });

    expect(await testKey({ keys, device, clientFor: factory }, "a", () => true)).toBeNull();
  });

  it("keeps the email of the key that is still in use when another account's key changes", async () => {
    const { keys, device } = setup();
    keys.set("a", "cb_a");
    const factory = clientFor(async () => {
      keys.set("b", "cb_b");
      return INFO;
    });

    const text = await testKey({ keys, device, clientFor: factory }, "a", () => true);

    expect(text).toContain("Connected as jo@example.com");
    expect(device.account("a").ownerEmail).toBe("jo@example.com");
  });
});
