import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startMockUpstream,
  startShim,
  TEST_API_KEY,
  type MockUpstream,
  type RunningShim,
} from "./test-helpers.js";
import { clearAliasCache } from "./api-surface.js";

const SANDBOX_ID = "abc123def456";

function cubeCreated(overrides: Record<string, unknown> = {}) {
  return {
    sandboxID: SANDBOX_ID,
    templateID: "tpl-x",
    clientID: "192.168.9.100",
    envdVersion: "0.2.0",
    domain: "cube.app",
    ...overrides,
  };
}

function cubeDetail(overrides: Record<string, unknown> = {}) {
  return {
    ...cubeCreated(),
    state: "running",
    startedAt: "2026-09-04T00:00:00Z",
    endAt: "2026-09-04T01:00:00Z",
    metadata: { "cube.product": "cubebox", "X-Caller": "X-Caller", team: "blue" },
    ...overrides,
  };
}

describe("api surface auth", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    upstream = await startMockUpstream(() => ({ status: 200, body: [] }));
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("rejects missing API key with E2B-shaped 401", async () => {
    const res = await fetch(`${shim.url}/sandboxes`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 401 });
    expect(upstream.requests).toHaveLength(0);
  });

  it("rejects wrong API key", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, { headers: { "X-API-Key": "nope" } });
    expect(res.status).toBe(401);
  });

  it("accepts configured key and forwards backend credential", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, { headers: { "X-API-Key": TEST_API_KEY } });
    expect(res.status).toBe(200);
    expect(upstream.requests[0].headers["x-api-key"]).toBe("cube-backend-key");
  });

  it("exempts /health from auth", async () => {
    const res = await fetch(`${shim.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });
});

describe("create sandbox", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("maps autoPause/autoResume onto Cube's nested lifecycle object", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        timeout: 600,
        autoPause: true,
        autoResume: { enabled: true },
      }),
    });
    expect(res.status).toBe(201);
    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.lifecycle).toEqual({ onTimeout: "pause", autoResume: true });
    expect(forwarded.autoPause).toBeUndefined();
    expect(forwarded.autoResume).toBeUndefined();
  });

  it("does not clobber a caller-provided lifecycle object", async () => {
    await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        lifecycle: { onTimeout: "kill" },
        autoPause: true,
      }),
    });
    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.lifecycle).toEqual({ onTimeout: "kill" });
  });

  it("fails closed instead of pretending filesystem-only auto-pause works", async () => {
    const before = upstream.requests.length;
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        autoPause: true,
        autoPauseMemory: false,
      }),
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 501 });
    expect(upstream.requests).toHaveLength(before);
  });

  it("mints envdAccessToken when secure and records the sandbox", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x", secure: true, timeout: 600 }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.envdAccessToken).toMatch(/^v1_/);
    expect(body.domain).toBe("sb.test");
    expect(body.startedAt).toBe("2026-09-04T00:00:00Z");
    expect(body.endAt).toBe("2026-09-04T01:00:00Z");

    const row = shim.store.getSandbox(SANDBOX_ID);
    expect(row).not.toBeNull();
    expect(row?.envdToken).toBe(body.envdAccessToken);
    expect(row?.timeoutSeconds).toBe(600);
  });

  it("omits envdAccessToken without secure", async () => {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x" }),
    });
    const body = await res.json();
    expect(body.envdAccessToken).toBeUndefined();
    expect(shim.store.getSandbox(SANDBOX_ID)?.envdToken).toBeNull();
  });

  it("relays upstream create errors unchanged", async () => {
    await upstream.close();
    await shim.close();
    upstream = await startMockUpstream(() => ({
      status: 500,
      body: { code: 500, message: "template not found" },
    }));
    shim = await startShim(upstream.url);
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-missing" }),
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ code: 500, message: "template not found" });
  });
});

describe("create-time environment compatibility", () => {
  it("initializes the complete E2B env map through private envd instead of CubeAPI", async () => {
    const cubeApi = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes") {
        return { status: 201, body: cubeCreated() };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
    const envd = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/init") return { status: 204 };
      return undefined;
    });
    const shim = await startShim(cubeApi.url, { cubeProxyUrl: envd.url });
    const envVars = {
      PYTHONPATH: "/app:/workspace",
      MULTILINE_SECRET: "line one\nline two",
      LARGE_CREDENTIAL: "x".repeat(5_000),
    };

    try {
      const res = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", envVars, secure: true }),
      });

      expect(res.status).toBe(201);
      const forwardedCreate = JSON.parse(cubeApi.requests[0]?.body ?? "{}");
      expect(forwardedCreate.envVars).toBeUndefined();
      expect(forwardedCreate.envs).toBeUndefined();

      expect(envd.requests).toHaveLength(1);
      expect(envd.requests[0]?.headers.host).toBe(`49983-${SANDBOX_ID}.cube.app`);
      expect(JSON.parse(envd.requests[0]?.body ?? "{}")).toEqual({ envVars });
    } finally {
      await shim.close();
      await envd.close();
      await cubeApi.close();
    }
  });

  it("kills a newly created sandbox when envd initialization fails without echoing secrets", async () => {
    const cubeApi = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes") {
        return { status: 201, body: cubeCreated() };
      }
      if (req.method === "DELETE" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 204 };
      }
      return undefined;
    });
    const secret = "super-secret-multiline\ncredential";
    const envd = await startMockUpstream((req) => ({
      status: 500,
      body: { message: `rejected ${req.body}` },
    }));
    const shim = await startShim(cubeApi.url, { cubeProxyUrl: envd.url });

    try {
      const res = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", envVars: { SECRET: secret } }),
      });

      expect(res.status).toBe(502);
      const responseText = await res.text();
      expect(responseText).not.toContain(secret);
      expect(responseText).toContain("Sandbox environment initialization failed");
      expect(cubeApi.requests.map((req) => `${req.method} ${req.path}`)).toEqual([
        "POST /sandboxes",
        `DELETE /sandboxes/${SANDBOX_ID}`,
      ]);
      expect(shim.store.getSandbox(SANDBOX_ID)).toBeNull();
    } finally {
      await shim.close();
      await envd.close();
      await cubeApi.close();
    }
  });

  it("rejects malformed envVars before creating a Cube sandbox", async () => {
    const cubeApi = await startMockUpstream(() => ({ status: 500 }));
    const shim = await startShim(cubeApi.url);
    try {
      const res = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", envVars: { BAD: 123 } }),
      });
      expect(res.status).toBe(400);
      expect(cubeApi.requests).toHaveLength(0);
    } finally {
      await shim.close();
      await cubeApi.close();
    }
  });
});

describe("pause/connect status semantics", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    let state = "running";
    upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail({ state }) };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/pause`) {
        state = "paused";
        return { status: 204 };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/connect`) {
        state = "running";
        return { status: 200, body: cubeCreated() };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/resume`) {
        state = "running";
        return { status: 201, body: cubeCreated() };
      }
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  async function createSecure(): Promise<string> {
    const res = await fetch(`${shim.url}/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ templateID: "tpl-x", secure: true }),
    });
    return (await res.json()).envdAccessToken;
  }

  it("answers 201 when connect resumed a paused sandbox, 200 when running", async () => {
    const token = await createSecure();

    const first = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 600 }),
    });
    expect(first.status).toBe(200);

    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ memory: true }),
    });
    expect(JSON.parse(upstream.requests.at(-1)?.body ?? "{}")).toEqual({ memory: true });

    const resumed = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 600 }),
    });
    expect(resumed.status).toBe(201);
    const body = await resumed.json();
    expect(body.envdAccessToken).toBe(token);
    expect(body.domain).toBe("sb.test");
  });

  it("exposes the deprecated resume route with E2B's 201 response", async () => {
    const token = await createSecure();
    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    });

    const resumed = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/resume`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 900, autoPause: true }),
    });

    expect(resumed.status).toBe(201);
    expect(await resumed.json()).toMatchObject({
      sandboxID: SANDBOX_ID,
      domain: "sb.test",
      envdAccessToken: token,
    });
    expect(JSON.parse(upstream.requests.at(-1)?.body ?? "{}")).toEqual({
      timeout: 900,
      autoPause: true,
    });
  });

  it("fails closed instead of treating memory=false as a full-memory pause", async () => {
    const token = await createSecure();
    expect(token).toMatch(/^v1_/);
    const before = upstream.requests.length;

    const res = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ memory: false }),
    });

    expect(res.status).toBe(501);
    expect(await res.json()).toMatchObject({ code: 501 });
    expect(upstream.requests).toHaveLength(before);
  });
});

describe("fork compatibility", () => {
  it("maps E2B fork onto one Cube snapshot and independently restored sandboxes", async () => {
    let createCount = 0;
    const cubeApi = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes") {
        createCount++;
        if (createCount === 1) return { status: 201, body: cubeCreated() };
        return {
          status: 201,
          body: cubeCreated({ sandboxID: `fork-${createCount - 1}`, templateID: "snap-fork" }),
        };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/snapshots`) {
        return { status: 201, body: { snapshotID: "snap-fork", names: [] } };
      }
      if (req.method === "DELETE" && req.path === "/templates/snap-fork") {
        return { status: 204 };
      }
      return undefined;
    });
    const shim = await startShim(cubeApi.url);

    try {
      await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", secure: true }),
      });

      const res = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/fork`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 900, count: 2 }),
      });

      expect(res.status).toBe(201);
      const results = await res.json();
      expect(results).toHaveLength(2);
      expect(results[0].sandbox).toMatchObject({
        sandboxID: "fork-1",
        domain: "sb.test",
      });
      expect(results[1].sandbox).toMatchObject({
        sandboxID: "fork-2",
        domain: "sb.test",
      });
      expect(results[0].sandbox.envdAccessToken).toMatch(/^v1_/);
      expect(results[1].sandbox.envdAccessToken).toMatch(/^v1_/);
      expect(results[0].sandbox.envdAccessToken).not.toBe(results[1].sandbox.envdAccessToken);

      const restored = cubeApi.requests.filter(
        (request) => request.method === "POST" && request.path === "/sandboxes"
      );
      expect(restored).toHaveLength(3);
      expect(JSON.parse(restored[1]?.body ?? "{}")).toEqual({
        templateID: "snap-fork",
        timeout: 900,
        secure: true,
      });
      expect(cubeApi.requests.at(-1)).toMatchObject({
        method: "DELETE",
        path: "/templates/snap-fork",
      });
      expect(shim.store.getSandbox("fork-1")?.envdToken).toBe(results[0].sandbox.envdAccessToken);
    } finally {
      await shim.close();
      await cubeApi.close();
    }
  });

  it("returns per-fork Cube failures without failing successful siblings", async () => {
    let forkCreate = 0;
    const cubeApi = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/snapshots`) {
        return { status: 201, body: { snapshotID: "snap-fork", names: [] } };
      }
      if (req.method === "POST" && req.path === "/sandboxes") {
        forkCreate++;
        if (forkCreate === 1) {
          return { status: 429, body: { code: 429, message: "capacity exceeded" } };
        }
        return { status: 201, body: cubeCreated({ sandboxID: "fork-ok" }) };
      }
      if (req.method === "DELETE" && req.path === "/templates/snap-fork") {
        return { status: 204 };
      }
      return undefined;
    });
    const shim = await startShim(cubeApi.url);

    try {
      const res = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/fork`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ count: 2 }),
      });
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual([
        { error: { code: 429, message: "capacity exceeded" } },
        { sandbox: cubeCreated({ sandboxID: "fork-ok", domain: "sb.test" }) },
      ]);
    } finally {
      await shim.close();
      await cubeApi.close();
    }
  });
});

describe("list filtering and pagination", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  const entries = [
    {
      sandboxID: "s1",
      templateID: "tpl-a",
      alias: "alpha",
      startedAt: "2026-09-04T03:00:00Z",
      state: "running",
      metadata: { team: "blue", "cube.product": "cubebox" },
    },
    {
      sandboxID: "s2",
      templateID: "tpl-b",
      startedAt: "2026-09-04T02:00:00Z",
      state: "paused",
      metadata: { team: "blue" },
    },
    {
      sandboxID: "s3",
      templateID: "tpl-a",
      startedAt: "2026-09-04T01:00:00Z",
      state: "running",
      metadata: { team: "red" },
    },
  ];

  beforeEach(async () => {
    upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/v2/sandboxes?limit=2147483647")
        return { status: 200, body: entries };
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  it("v2 filters by state and strips cube-internal metadata", async () => {
    const res = await fetch(`${shim.url}/v2/sandboxes?state=running`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s1", "s3"]);
    expect(body[0].metadata).toEqual({ team: "blue" });
    expect(res.headers.get("X-Total-Running")).toBe("2");
    expect(upstream.requests[0]?.path).toBe("/v2/sandboxes?limit=2147483647");
  });

  it("v2 filters by embedded metadata query", async () => {
    const res = await fetch(
      `${shim.url}/v2/sandboxes?metadata=${encodeURIComponent("team=blue")}`,
      {
        headers: { "X-API-Key": TEST_API_KEY },
      }
    );
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s1", "s2"]);
  });

  it("v2 paginates with limit and nextToken cursor", async () => {
    const page1 = await fetch(`${shim.url}/v2/sandboxes?limit=2`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body1 = await page1.json();
    expect(body1).toHaveLength(2);
    const cursor = page1.headers.get("X-Next-Token");
    expect(cursor).toBeTruthy();

    const page2 = await fetch(`${shim.url}/v2/sandboxes?limit=2&nextToken=${cursor}`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body2 = await page2.json();
    expect(body2).toHaveLength(1);
    expect(page2.headers.get("X-Next-Token")).toBeNull();
  });

  it("v1 always returns running sandboxes and ignores the v2-only state parameter", async () => {
    const res = await fetch(`${shim.url}/sandboxes?state=paused`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s1", "s3"]);
  });

  it("v2 filters by start time and template, and sorts ascending", async () => {
    const res = await fetch(
      `${shim.url}/v2/sandboxes?template=tpl-a&startedAfter=2026-09-04T00%3A30%3A00Z&order=asc`,
      { headers: { "X-API-Key": TEST_API_KEY } }
    );
    const body = await res.json();
    expect(body.map((s: { sandboxID: string }) => s.sandboxID)).toEqual(["s3", "s1"]);
  });

  it("only emits X-Total-Running when running was explicitly requested", async () => {
    const unfiltered = await fetch(`${shim.url}/v2/sandboxes`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    expect(unfiltered.headers.get("X-Total-Running")).toBeNull();

    const filtered = await fetch(`${shim.url}/v2/sandboxes?state=running,paused`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    expect(filtered.headers.get("X-Total-Running")).toBe("2");
  });
});

describe("Cube v0.7 standard passthrough routes", () => {
  it("forwards network, refresh, snapshot, log and volume APIs", async () => {
    const upstream = await startMockUpstream((req) => {
      if (req.path === "/snapshots?limit=1") {
        return { status: 200, body: [], headers: { "X-Next-Token": "next-snapshot" } };
      }
      if (req.path === "/volumes" && req.method === "POST") {
        return { status: 201, body: { volumeID: "vol-1", token: "token" } };
      }
      if (req.path === "/volumes/vol-1" && req.method === "DELETE") return { status: 204 };
      if (req.path.endsWith("/snapshots")) {
        return { status: 201, body: { snapshotID: "snap-1:default", names: [] } };
      }
      if (req.path.endsWith("/logs")) return { status: 200, body: { logs: [] } };
      return { status: 204 };
    });
    const shim = await startShim(upstream.url);
    const headers = { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" };
    try {
      const network = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/network`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ allow_internet_access: false }),
      });
      expect(network.status).toBe(204);

      const refresh = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/refreshes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ duration: 300 }),
      });
      expect(refresh.status).toBe(204);

      const snapshot = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/snapshots`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "checkpoint" }),
      });
      expect(snapshot.status).toBe(201);
      expect(await snapshot.json()).toMatchObject({ snapshotID: "snap-1:default" });

      const snapshots = await fetch(`${shim.url}/snapshots?limit=1`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(snapshots.headers.get("X-Next-Token")).toBe("next-snapshot");

      const logs = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/logs`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(logs.status).toBe(200);

      const volume = await fetch(`${shim.url}/volumes`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "cache" }),
      });
      expect(volume.status).toBe(201);

      const deleted = await fetch(`${shim.url}/volumes/vol-1`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(deleted.status).toBe(204);
    } finally {
      await shim.close();
      await upstream.close();
    }

    expect(upstream.requests.map((req) => `${req.method} ${req.path}`)).toEqual([
      `PUT /sandboxes/${SANDBOX_ID}/network`,
      `POST /sandboxes/${SANDBOX_ID}/refreshes`,
      `POST /sandboxes/${SANDBOX_ID}/snapshots`,
      "GET /snapshots?limit=1",
      `GET /sandboxes/${SANDBOX_ID}/logs`,
      "POST /volumes",
      "DELETE /volumes/vol-1",
    ]);
  });
});

describe("template v3 build API", () => {
  it("maps POST /v3/templates onto Cube from-image POST /templates", async () => {
    const upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/templates") {
        const body = JSON.parse(req.body);
        return {
          status: 202,
          body: {
            templateID: "tpl-built",
            jobID: "job-1",
            status: "BUILDING",
            aliases: body.aliases,
          },
        };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      const res = await fetch(`${shim.url}/v3/templates`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ name: "localhost:5000/cube-e2b:latest", alias: "cube-e2b" }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body.templateID).toBe("tpl-built");
      expect(body.buildID).toBe("job-1");
      expect(body.buildStatusEnum).toBe("building");
      expect(body.names).toEqual(["localhost:5000/cube-e2b:latest"]);
      expect(body.aliases).toEqual(["cube-e2b"]);

      const forwarded = JSON.parse(upstream.requests[0].body);
      expect(forwarded.image).toBe("localhost:5000/cube-e2b:latest");
      expect(forwarded.aliases).toEqual(["cube-e2b"]);
    } finally {
      await shim.close();
      await upstream.close();
    }
  });

  it("build status translates Cube READY to E2B ready", async () => {
    const upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/templates/tpl-built") {
        return {
          status: 200,
          body: {
            templateID: "tpl-built",
            jobID: "job-1",
            status: "READY",
            aliases: ["cube-e2b"],
            createdAt: "2026-09-05T00:00:00Z",
          },
        };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      const res = await fetch(`${shim.url}/templates/tpl-built/builds/job-1/status`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe("ready");
      expect(body.templateID).toBe("tpl-built");
      expect(body.buildID).toBe("job-1");
    } finally {
      await shim.close();
      await upstream.close();
    }
  });

  it("trigger endpoint acknowledges without re-running", async () => {
    const shim = await startShim("http://127.0.0.1:1");
    try {
      const res = await fetch(`${shim.url}/v2/templates/tpl-built/builds/job-1`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(res.status).toBe(202);
    } finally {
      await shim.close();
    }
  });
});

describe("template alias resolution", () => {
  it("resolves an alias to its templateID before forwarding create", async () => {
    clearAliasCache();
    const upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/templates") {
        return { status: 200, body: [{ templateID: "tpl-real", aliases: ["my-alias"] }] };
      }
      if (req.method === "POST" && req.path === "/sandboxes") {
        const body = JSON.parse(req.body);
        if (body.templateID !== "tpl-real") {
          return { status: 404, body: { code: 404, message: "template not found" } };
        }
        return { status: 201, body: cubeCreated({ templateID: "tpl-real" }) };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      const res = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "my-alias" }),
      });
      expect(res.status).toBe(201);

      clearAliasCache();
      const missing = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "no-such-alias" }),
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ code: 404 });
    } finally {
      await shim.close();
      await upstream.close();
    }
  });
});

describe("metrics transform", () => {
  it("maps envd single-point JSON onto E2B SandboxMetric[]", async () => {
    const { transformEnvdMetrics } = await import("./api-surface.js");
    const envd = JSON.stringify({
      ts: 1788578431,
      cpu_count: 4,
      cpu_used_pct: 2.41,
      mem_total: 8338272256,
      mem_used: 549847040,
      mem_cache: 17616896,
      disk_used: 217157632,
      disk_total: 3921543168,
    });
    expect(transformEnvdMetrics(envd)).toEqual([
      {
        timestamp: "2026-09-05T03:20:31.000Z",
        timestampUnix: 1788578431,
        cpuCount: 4,
        cpuUsedPct: 2.41,
        memUsed: 549847040,
        memTotal: 8338272256,
        memCache: 17616896,
        diskUsed: 217157632,
        diskTotal: 3921543168,
      },
    ]);
  });

  it("degrades unknown payloads to an empty series", async () => {
    const { transformEnvdMetrics } = await import("./api-surface.js");
    expect(transformEnvdMetrics("not json")).toEqual([]);
    expect(transformEnvdMetrics('{"foo":1}')).toEqual([]);
  });
});

describe("kill and get", () => {
  it("get strips internal metadata and kill forgets the sandbox", async () => {
    let alive = true;
    const upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes")
        return { status: 201, body: cubeCreated() };
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return alive
          ? { status: 200, body: cubeDetail() }
          : { status: 404, body: { code: 404, message: "not found" } };
      }
      if (req.method === "DELETE" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        alive = false;
        return { status: 204 };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x" }),
      });
      const get = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      const detail = await get.json();
      expect(detail.metadata).toEqual({ team: "blue" });
      expect(detail.domain).toBe("sb.test");

      const kill = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}`, {
        method: "DELETE",
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(kill.status).toBe(204);
      expect(shim.store.getSandbox(SANDBOX_ID)).toBeNull();
    } finally {
      await shim.close();
      await upstream.close();
    }
  });
});
