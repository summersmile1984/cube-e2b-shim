import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startMockUpstream,
  startShim,
  TEST_ACCESS_TOKEN,
  TEST_ADMIN_TOKEN,
  TEST_API_KEY,
  TEST_TEAM_ID,
  type MockUpstream,
  type RunningShim,
} from "./test-helpers.js";

let upstream: MockUpstream;
let shim: RunningShim;

beforeEach(async () => {
  upstream = await startMockUpstream((req) =>
    req.method === "GET" && req.path.startsWith("/v2/sandboxes") ? { status: 200, body: [] } : undefined
  );
  shim = await startShim(upstream.url);
});
afterEach(async () => {
  await shim.close();
  await upstream.close();
});

const call = (path: string, headers: Record<string, string>, init: RequestInit = {}) =>
  fetch(`${shim.url}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...headers, ...(init.headers as object) },
  });
const apiKey = { "X-API-Key": TEST_API_KEY };
const bearer = { Authorization: `Bearer ${TEST_ACCESS_TOKEN}` };
const admin = { "X-Admin-Token": TEST_ADMIN_TOKEN };

describe("authentication schemes", () => {
  it("accepts API keys, access tokens and admin tokens, and refuses other teams", async () => {
    expect((await call("/v2/sandboxes", apiKey)).status).toBe(200);
    expect((await call("/v2/sandboxes", { ...bearer, "X-Team-ID": TEST_TEAM_ID })).status).toBe(200);
    expect((await call("/v2/sandboxes", { ...admin, "X-Team-ID": TEST_TEAM_ID })).status).toBe(200);
    expect((await call("/v2/sandboxes", { ...apiKey, "X-Team-ID": "someone-else" })).status).toBe(403);
    expect((await call("/v2/sandboxes", { Authorization: "Bearer nope" })).status).toBe(401);
    expect((await call("/v2/sandboxes", { "X-Admin-Token": "nope" })).status).toBe(401);
  });

  it("enforces per-endpoint schemes (teams need an access token, admin APIs an admin token)", async () => {
    expect((await call("/teams", apiKey)).status).toBe(401);
    const teams = await call("/teams", bearer);
    expect(teams.status).toBe(200);
    expect(await teams.json()).toEqual([
      { teamID: TEST_TEAM_ID, name: "default", apiKey: TEST_API_KEY, isDefault: true },
    ]);
    expect((await call("/admin/sandboxes/running-counts", apiKey)).status).toBe(403);
  });
});

describe("API keys", () => {
  it("creates, lists, renames, authenticates with and deletes managed keys", async () => {
    const created = await call("/api-keys", bearer, {
      method: "POST",
      body: JSON.stringify({ name: "ci" }),
    });
    expect(created.status).toBe(201);
    const key = await created.json();
    expect(key.key).toMatch(/^e2b_[0-9a-f]{40}$/);
    expect(key.mask).toMatchObject({ prefix: "e2b_", valueLength: 40 });
    expect(key.mask.maskedValueSuffix).toBe(key.key.slice(-4));

    // The new key works on the API surface, and last use is recorded.
    expect((await call("/v2/sandboxes", { "X-API-Key": key.key })).status).toBe(200);
    const listed = await (await call("/api-keys", bearer)).json();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: key.id, name: "ci" });
    expect(listed[0].lastUsed).not.toBeNull();
    expect(listed[0].key).toBeUndefined();

    const renamed = await call(`/api-keys/${key.id}`, bearer, {
      method: "PATCH",
      body: JSON.stringify({ name: "ci-renamed" }),
    });
    expect(renamed.status).toBe(200);
    expect((await (await call("/api-keys", bearer)).json())[0].name).toBe("ci-renamed");

    expect((await call(`/api-keys/${key.id}`, bearer, { method: "DELETE" })).status).toBe(204);
    expect((await call("/v2/sandboxes", { "X-API-Key": key.key })).status).toBe(401);
    expect((await call(`/api-keys/${key.id}`, bearer, { method: "DELETE" })).status).toBe(404);
  });

  it("only lets access tokens create keys, and admins manage them per team", async () => {
    expect(
      (await call("/api-keys", apiKey, { method: "POST", body: JSON.stringify({ name: "x" }) })).status
    ).toBe(401);
    const created = await call(`/admin/teams/${TEST_TEAM_ID}/api-keys`, admin, {
      method: "POST",
      body: JSON.stringify({ name: "ops" }),
    });
    expect(created.status).toBe(201);
    const { id } = await created.json();
    expect(
      (await call(`/admin/teams/other/api-keys`, admin, { method: "POST", body: JSON.stringify({ name: "x" }) }))
        .status
    ).toBe(404);
    expect((await call(`/admin/teams/${TEST_TEAM_ID}/api-keys/${id}`, admin, { method: "DELETE" })).status).toBe(
      204
    );
  });
});

describe("admin APIs", () => {
  it("kills the team's sandboxes, counts running ones and skips internal sandboxes", async () => {
    const live = new Map([
      ["a", { state: "running" }],
      ["b", { state: "paused" }],
      ["build", { state: "running", metadata: { "cube-e2b-shim.build": "x" } }],
    ]);
    const cube = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path.startsWith("/v2/sandboxes")) {
        return { status: 200, body: [...live].map(([sandboxID, s]) => ({ sandboxID, templateID: "tpl", ...s })) };
      }
      const kill = /^\/sandboxes\/([^/]+)$/.exec(req.path);
      if (req.method === "DELETE" && kill) {
        live.delete(kill[1]);
        return { status: 204 };
      }
      return undefined;
    });
    const admin2 = await startShim(cube.url);
    const call2 = (path: string, init: RequestInit = {}) =>
      fetch(`${admin2.url}${path}`, { ...init, headers: admin });
    try {
      expect(await (await call2("/admin/sandboxes/running-counts")).json()).toEqual({ [TEST_TEAM_ID]: 1 });
      const killed = await call2(`/admin/teams/${TEST_TEAM_ID}/sandboxes/kill`, { method: "POST" });
      expect(await killed.json()).toEqual({ killedCount: 2, failedCount: 0 });
      expect([...live.keys()]).toEqual(["build"]);
      expect(await (await call2("/admin/sandboxes/running-counts")).json()).toEqual({});
      expect(
        await (await call2(`/admin/teams/${TEST_TEAM_ID}/builds/cancel`, { method: "POST" })).json()
      ).toEqual({ cancelledCount: 0, failedCount: 0 });
      expect((await call2(`/admin/teams/other/sandboxes/kill`, { method: "POST" })).status).toBe(404);
    } finally {
      await admin2.close();
      await cube.close();
    }
  });

  it("maps CubeOps nodes onto E2B nodes and isolation onto draining", async () => {
    const ops = await startMockUpstream((req) => {
      if (req.headers.authorization !== "Bearer ops-token") return { status: 401 };
      const node = {
        nodeID: "node-1",
        hostIP: "10.0.0.1",
        healthy: true,
        schedulingDisabled: false,
        capacity: { cpuMilli: 16000, memoryMB: 32768 },
        allocatable: { cpuMilli: 12000, memoryMB: 24576 },
        cpuSaturation: 0.25,
        maxMvmSlots: 50,
        versions: [{ component: "cubelet", version: "0.7.2", commit: "abc" }],
      };
      if (req.method === "GET" && req.path === "/api/v1/nodes") return { status: 200, body: [node] };
      if (req.method === "GET" && req.path === "/api/v1/nodes/node-1") return { status: 200, body: node };
      if (req.path === "/api/v1/nodes/node-1/isolation") return { status: 200, body: {} };
      return { status: 404, body: { error: "not found" } };
    });
    const cube = await startMockUpstream(() => ({
      status: 200,
      body: [{ sandboxID: "s1", state: "running", clientID: "10.0.0.1" }],
    }));
    const nodesShim = await startShim(cube.url, { cubeOpsUrl: ops.url, cubeOpsToken: "ops-token" });
    const call2 = (path: string, init: RequestInit = {}) =>
      fetch(`${nodesShim.url}${path}`, { ...init, headers: { ...admin, "Content-Type": "application/json" } });
    try {
      const nodes = await (await call2("/nodes")).json();
      expect(nodes[0]).toMatchObject({
        id: "node-1",
        status: "ready",
        sandboxCount: 1,
        maxSandboxes: 50,
        version: "0.7.2",
        metrics: { cpuCount: 16, allocatedCPU: 4, cpuPercent: 25, memoryTotalBytes: 32768 * 1024 * 1024 },
      });
      expect((await call2("/nodes/node-1")).status).toBe(200);
      expect((await call2("/nodes/missing")).status).toBe(404);

      const drain = await call2("/nodes/node-1", { method: "POST", body: JSON.stringify({ status: "draining" }) });
      expect(drain.status).toBe(204);
      expect(ops.requests.at(-1)).toMatchObject({ method: "PUT", path: "/api/v1/nodes/node-1/isolation" });
      await call2("/nodes/node-1", { method: "POST", body: JSON.stringify({ status: "ready" }) });
      expect(ops.requests.at(-1)).toMatchObject({ method: "DELETE" });
      expect(
        (await call2("/nodes/node-1", { method: "POST", body: JSON.stringify({ status: "unhealthy" }) })).status
      ).toBe(409);

      expect((await call2("/clusters/c/rigs")).status).toBe(501);
    } finally {
      await nodesShim.close();
      await cube.close();
      await ops.close();
    }
  });

  it("answers 501 for node APIs when CubeOps is not configured", async () => {
    expect((await call("/nodes", admin)).status).toBe(501);
  });
});
