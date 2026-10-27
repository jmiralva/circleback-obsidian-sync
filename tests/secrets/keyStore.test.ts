import { randomUUID } from "crypto";
import { createFakeApp } from "../harness/fakeApp";
import { KeyStore } from "../../src/secrets/keyStore";

describe("KeyStore", () => {
  it("secret id is circleback-sync-<uuid> and valid", () => {
    const uuid = randomUUID();
    const id = new KeyStore(createFakeApp()).secretId(uuid);
    expect(id).toBe(`circleback-sync-${uuid}`);
    expect(id).toMatch(/^[a-z0-9-]+$/);
    expect(id.length).toBeLessThanOrEqual(64);
  });

  it("stores and reads a key under that id in Obsidian's secret storage", () => {
    const app = createFakeApp();
    const keys = new KeyStore(app);
    const uuid = randomUUID();
    keys.set(uuid, "cb_secret");
    expect(keys.get(uuid)).toBe("cb_secret");
    expect(app.secretStorage.getSecret(`circleback-sync-${uuid}`)).toBe("cb_secret");
  });

  it("reads null when no key was ever stored (key needed on this device)", () => {
    expect(new KeyStore(createFakeApp()).get("u1")).toBeNull();
  });

  it("empty secret reads as null", () => {
    const keys = new KeyStore(createFakeApp());
    keys.set("u1", "");
    expect(keys.get("u1")).toBeNull();
  });

  it("clear makes the key read as null by storing an empty secret", () => {
    const app = createFakeApp();
    const keys = new KeyStore(app);
    keys.set("u1", "cb_secret");
    keys.clear("u1");
    expect(keys.get("u1")).toBeNull();
    expect(app.secretStorage.getSecret("circleback-sync-u1")).toBe("");
  });

  it("replaces an existing key", () => {
    const keys = new KeyStore(createFakeApp());
    keys.set("u1", "cb_old");
    keys.set("u1", "cb_new");
    expect(keys.get("u1")).toBe("cb_new");
  });

  it("keeps each account's key apart", () => {
    const keys = new KeyStore(createFakeApp());
    keys.set("u1", "cb_one");
    keys.set("u2", "cb_two");
    keys.clear("u1");
    expect(keys.get("u1")).toBeNull();
    expect(keys.get("u2")).toBe("cb_two");
  });

  it("reads keys another KeyStore on the same app stored", () => {
    const app = createFakeApp();
    new KeyStore(app).set("u1", "cb_secret");
    expect(new KeyStore(app).get("u1")).toBe("cb_secret");
  });
});
