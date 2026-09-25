import { describe, it, expect } from "vitest";
import { parseFindOutput, volumePath } from "./volume-content.js";
import { startMockUpstream, startShim, TEST_API_KEY } from "./test-helpers.js";

describe("volume content helpers", () => {
  it("keeps every path inside the volume", () => {
    expect(volumePath("a/b/")).toBe("/a/b");
    expect(volumePath("/../../etc/passwd")).toBe("/etc/passwd");
    expect(volumePath("/")).toBe("/");
    expect(() => volumePath(null)).toThrow();
    expect(() => volumePath("a\0b")).toThrow();
  });

  it("parses GNU find records into VolumeEntryStat", () => {
    const f = "\u001f";
    const out =
      `d${f}4096${f}755${f}0${f}0${f}1700000000.5${f}1700000001.0${f}1700000002.0${f}/mnt/e2b-volume/dir${f}\u001e` +
      `l${f}7${f}777${f}1000${f}1000${f}1700000000${f}1700000000${f}1700000000${f}/mnt/e2b-volume/dir/ln${f}target\u001e`;
    expect(parseFindOutput(out)).toEqual([
      {
        name: "dir",
        type: "directory",
        path: "/dir",
        size: 4096,
        mode: 0o755,
        uid: 0,
        gid: 0,
        atime: "2023-11-14T22:13:20.500Z",
        mtime: "2023-11-14T22:13:21.000Z",
        ctime: "2023-11-14T22:13:22.000Z",
      },
      expect.objectContaining({ name: "ln", type: "symlink", path: "/dir/ln", target: "target", uid: 1000 }),
    ]);
  });
});

describe("volume tokens", () => {
  it("adds a content token to single-volume responses and enforces it", async () => {
    const cube = await startMockUpstream((req) => {
      if (req.path === "/volumes" && req.method === "POST") return { status: 201, body: { volumeID: "v1", name: "d", token: "" } };
      if (req.path === "/volumes/v1") return { status: 200, body: { volumeID: "v1", name: "d", token: "", domain: "x" } };
      if (req.path === "/volumes") return { status: 200, body: [{ volumeID: "v1", name: "d" }] };
      return undefined;
    });
    const shim = await startShim(cube.url);
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${shim.url}${path}`, { ...init, headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" } });
    try {
      const created = await (await api("/volumes", { method: "POST", body: JSON.stringify({ name: "d" }) })).json();
      expect(created.token).toMatch(/^vol_/);
      const got = await (await api("/volumes/v1")).json();
      expect(got).toEqual({ volumeID: "v1", name: "d", token: created.token });
      expect(await (await api("/volumes")).json()).toEqual([{ volumeID: "v1", name: "d" }]);

      const denied = await fetch(`${shim.url}/volumecontent/v1/path?path=/`, {
        headers: { Authorization: "Bearer nope" },
      });
      expect(denied.status).toBe(401);
      expect(await denied.json()).toMatchObject({ code: "unauthorized" });
      // The volume-content API never accepts API keys.
      const withKey = await fetch(`${shim.url}/volumecontent/v1/path?path=/`, { headers: { "X-API-Key": TEST_API_KEY } });
      expect(withKey.status).toBe(401);
    } finally {
      await shim.close();
      await cube.close();
    }
  });
});
