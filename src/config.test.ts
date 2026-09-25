import { describe, it, expect } from "vitest";
import { ConfigError, loadConfig } from "./config.js";

const BASE_ENV = {
  SHIM_API_KEYS: "k1",
  CUBE_API_KEY: "cube-key",
};

describe("loadConfig", () => {
  it("requires SHIM_DB_PATH so envd tokens are never silently volatile", () => {
    expect(() => loadConfig({ ...BASE_ENV })).toThrow(ConfigError);
    expect(() => loadConfig({ ...BASE_ENV, SHIM_DB_PATH: "  " })).toThrow(/SHIM_DB_PATH/);
  });

  it("accepts a durable path or an explicit :memory:", () => {
    expect(loadConfig({ ...BASE_ENV, SHIM_DB_PATH: "/var/lib/shim.db" }).dbPath).toBe(
      "/var/lib/shim.db"
    );
    expect(loadConfig({ ...BASE_ENV, SHIM_DB_PATH: ":memory:" }).dbPath).toBe(":memory:");
  });
});
