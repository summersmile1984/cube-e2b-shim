import http from "node:http";
import type { AddressInfo } from "node:net";
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

  it("v2 create always mints envdAccessToken without a secure field", async () => {
    const res = await fetch(`${shim.url}/v2/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        metadata: { team: "blue" },
        allow_internet_access: false,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.envdAccessToken).toMatch(/^v1_/);
    expect(body.envdVersion).toBe("0.2.0");
    expect(body.domain).toBe("sb.test");

    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(upstream.requests[0].path).toBe("/sandboxes");
    expect(forwarded).toMatchObject({
      templateID: "tpl-x",
      timeout: 300,
      secure: true,
      metadata: { team: "blue" },
      allow_internet_access: false,
    });

    const row = shim.store.getSandbox(SANDBOX_ID);
    expect(row?.envdToken).toBe(body.envdAccessToken);
    expect(row?.timeoutSeconds).toBe(300);
  });

  it("v2 create keeps an explicit timeout and maps lifecycle fields", async () => {
    const res = await fetch(`${shim.url}/v2/sandboxes`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        templateID: "tpl-x",
        timeout: 60,
        autoPause: true,
        autoResume: { enabled: true },
      }),
    });
    expect(res.status).toBe(201);
    const forwarded = JSON.parse(upstream.requests[0].body);
    expect(forwarded.timeout).toBe(60);
    expect(forwarded.lifecycle).toEqual({ onTimeout: "pause", autoResume: true });
  });

  it("v2 create rejects a missing templateID and non-object bodies", async () => {
    for (const body of ["{}", "[]", "null"]) {
      const res = await fetch(`${shim.url}/v2/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body,
      });
      expect(res.status).toBe(400);
    }
    expect(upstream.requests).toHaveLength(0);
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
      const created = await res.json();
      expect(JSON.parse(envd.requests[0]?.body ?? "{}")).toEqual({
        envVars,
        accessToken: created.envdAccessToken,
      });
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

  it("v2 connect defaults the timeout, keeps 200/201 semantics and returns the token", async () => {
    const token = await createSecure();

    const running = await fetch(`${shim.url}/v2/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    });
    expect(running.status).toBe(200);
    expect(upstream.requests.at(-1)?.path).toBe(`/sandboxes/${SANDBOX_ID}/connect`);
    expect(JSON.parse(upstream.requests.at(-1)?.body ?? "{}")).toEqual({ timeout: 300 });
    expect((await running.json()).envdAccessToken).toBe(token);

    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const resumed = await fetch(`${shim.url}/v2/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ timeout: 120, memory: true }),
    });
    expect(resumed.status).toBe(201);
    expect(JSON.parse(upstream.requests.at(-1)?.body ?? "{}")).toEqual({ timeout: 120 });
    expect(await resumed.json()).toMatchObject({ envdAccessToken: token, domain: "sb.test" });
  });

  it("v2 connect rejects a disk-only reboot of a paused sandbox instead of downgrading", async () => {
    await createSecure();
    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/pause`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const before = upstream.requests.length;

    const res = await fetch(`${shim.url}/v2/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ memory: false }),
    });
    expect(res.status).toBe(400);
    expect(upstream.requests.slice(before).some((r) => r.path.endsWith("/connect"))).toBe(false);
  });

  it("v2 connect ignores memory=false for a running sandbox", async () => {
    await createSecure();
    const res = await fetch(`${shim.url}/v2/sandboxes/${SANDBOX_ID}/connect`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ memory: false }),
    });
    expect(res.status).toBe(200);
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
      const source = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", secure: true }),
      });
      const sourceToken = (await source.json()).envdAccessToken;

      const res = await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/fork`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ timeout: 900, count: 2 }),
      });

      expect(res.status).toBe(201);
      const results = await res.json();
      expect(results).toHaveLength(2);
      // Cube assigns fork IDs in upstream arrival order, which may differ from
      // the order the shim issued the concurrent create calls. Assert on the
      // identities rather than on positional array order.
      const byId = new Map(
        results.map((result: { sandbox: { sandboxID: string } }) => [result.sandbox.sandboxID, result.sandbox])
      );
      expect([...byId.keys()].sort()).toEqual(["fork-1", "fork-2"]);
      const first = byId.get("fork-1");
      const second = byId.get("fork-2");
      expect(first).toMatchObject({
        sandboxID: "fork-1",
        domain: "sb.test",
      });
      expect(second).toMatchObject({
        sandboxID: "fork-2",
        domain: "sb.test",
      });
      // A fork's envd is restored from the source's memory and envd refuses
      // to swap its token, so forks carry (and re-assert) the source token.
      expect(first?.envdAccessToken).toBe(sourceToken);
      expect(second?.envdAccessToken).toBe(sourceToken);
      const forkInits = (shim.envd?.requests ?? []).filter((r) => r.headers.host?.startsWith("49983-fork-"));
      expect(forkInits).toHaveLength(2);
      for (const init of forkInits) {
        expect(JSON.parse(init.body)).toEqual({ accessToken: sourceToken });
      }

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
      expect(shim.store.getSandbox("fork-1")?.envdToken).toBe(first?.envdAccessToken);
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
  /**
   * Fake envd speaking the Connect streaming process API plus /health,
   * /files and /init. The command "exit 1" fails; ENV printf
   * evaluation echoes the quoted value back.
   */
  async function startFakeEnvd() {
    const commands: Array<{ command: string; user?: string; cwd?: string; envs?: unknown }> = [];
    const inits: unknown[] = [];
    const uploads: string[] = [];
    const frame = (obj: unknown, flags = 0) => {
      const payload = Buffer.from(JSON.stringify(obj));
      const head = Buffer.alloc(5);
      head.writeUInt8(flags, 0);
      head.writeUInt32BE(payload.length, 1);
      return Buffer.concat([head, payload]);
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        if (req.url === "/health") {
          res.writeHead(204);
          return res.end();
        }
        if (req.url === "/init") {
          inits.push(JSON.parse(body.toString("utf8")));
          res.writeHead(204);
          return res.end();
        }
        if (req.url?.startsWith("/files")) {
          uploads.push(new URL(req.url, "http://x").searchParams.get("path") ?? "");
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end("[]");
        }
        if (req.url === "/process.Process/Start") {
          const message = JSON.parse(body.subarray(5).toString("utf8"));
          const command: string = message.process.args[2];
          const auth = req.headers.authorization;
          commands.push({
            command,
            user: auth ? Buffer.from(auth.slice(6), "base64").toString().replace(/:$/, "") : undefined,
            cwd: message.process.cwd,
            envs: message.process.envs,
          });
          const printf = /^printf "%s" "(.*)"$/s.exec(command);
          const stdout = printf ? printf[1] : "ok\n";
          const exitCode = command === "exit 1" ? 1 : 0;
          res.writeHead(200, { "Content-Type": "application/connect+json" });
          res.write(frame({ event: { start: { pid: 7 } } }));
          res.write(frame({ event: { data: { stdout: Buffer.from(stdout).toString("base64") } } }));
          res.write(frame({ event: { end: { exitCode, exited: true, status: `exit status ${exitCode}` } } }));
          return res.end(frame({}, 2));
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      commands,
      inits,
      uploads,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  function fakeCube() {
    let snapshots = 0;
    return startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/templates") {
        return {
          status: 200,
          body: [
            { templateID: "tpl-base", aliases: ["base"], status: "READY", createdAt: "2026-09-01T00:00:00Z" },
            ...Array.from({ length: snapshots }, (_, i) => ({ templateID: `snap-built-${i + 1}`, aliases: [] })),
          ],
        };
      }
      if (req.method === "GET" && req.path === "/templates/tpl-base") {
        return {
          status: 200,
          body: {
            templateID: "tpl-base",
            aliases: ["base"],
            status: "READY",
            jobID: "job-base",
            createdAt: "2026-09-01T00:00:00Z",
            createRequest: { cpu: 4000, memory: 2048, writableLayerSize: "8G" },
          },
        };
      }
      if (req.method === "POST" && req.path === "/sandboxes") {
        const body = JSON.parse(req.body);
        const id = body.metadata?.["cube-e2b-shim.build"] ? "buildsbx1" : SANDBOX_ID;
        return { status: 201, body: cubeCreated({ sandboxID: id, templateID: body.templateID }) };
      }
      if (req.method === "POST" && req.path === "/sandboxes/buildsbx1/snapshots") {
        return { status: 201, body: { snapshotID: `snap-built-${++snapshots}`, names: [] } };
      }
      if (req.method === "DELETE") return { status: 204 };
      if (req.method === "GET" && req.path.startsWith("/v2/sandboxes")) {
        return {
          status: 200,
          body: [
            cubeDetail({ sandboxID: "buildsbx1", metadata: { "cube-e2b-shim.build": "b" } }),
            cubeDetail(),
          ],
        };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      return undefined;
    });
  }

  const api = (shim: RunningShim, path: string, init: RequestInit = {}) =>
    fetch(`${shim.url}${path}`, {
      ...init,
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json", ...init.headers },
    });

  async function waitForBuild(shim: RunningShim, templateID: string, buildID: string) {
    for (let i = 0; i < 100; i++) {
      const res = await api(shim, `/templates/${templateID}/builds/${buildID}/status`);
      const body = await res.json();
      if (body.status === "ready" || body.status === "error") return body;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("build did not finish");
  }

  it("reserves a build under the template name without touching Cube", async () => {
    const cube = await fakeCube();
    const shim = await startShim(cube.url);
    try {
      const res = await api(shim, "/v3/templates", {
        method: "POST",
        body: JSON.stringify({ name: "my-app:v1", cpuCount: 2, memoryMB: 1024 }),
      });
      expect(res.status).toBe(202);
      const body = await res.json();
      expect(body).toMatchObject({ templateID: "my-app", names: ["my-app"], tags: ["v1"], public: false });
      expect(body.buildID).toMatch(/^[0-9a-f-]{36}$/);
      expect(cube.requests).toHaveLength(0);

      const bad = await api(shim, "/v3/templates", {
        method: "POST",
        body: JSON.stringify({ name: "../etc" }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await shim.close();
      await cube.close();
    }
  });

  it("hands out a presigned upload URL and accepts the archive without an API key", async () => {
    const cube = await fakeCube();
    const shim = await startShim(cube.url);
    const hash = "a".repeat(64);
    try {
      const first = await api(shim, `/templates/my-app/files/${hash}`);
      expect(first.status).toBe(201);
      const link = await first.json();
      expect(link.present).toBe(false);
      const uploadUrl = new URL(link.url);
      expect(uploadUrl.pathname).toBe(`/template-files/${hash}`);

      const forged = new URL(uploadUrl);
      forged.searchParams.set("signature", "nope");
      expect((await fetch(forged, { method: "PUT", body: "x" })).status).toBe(403);

      const put = await fetch(uploadUrl, { method: "PUT", body: "tar-bytes" });
      expect(put.status).toBe(200);
      expect(await (await api(shim, `/templates/my-app/files/${hash}`)).json()).toEqual({ present: true });
    } finally {
      await shim.close();
      await cube.close();
    }
  });

  it("rejects invalid build requests before starting anything", async () => {
    const cube = await fakeCube();
    const shim = await startShim(cube.url);
    try {
      const { buildID } = await (
        await api(shim, "/v3/templates", { method: "POST", body: JSON.stringify({ name: "my-app" }) })
      ).json();
      const trigger = (body: unknown, template = "my-app", build = buildID) =>
        api(shim, `/v2/templates/${template}/builds/${build}`, {
          method: "POST",
          body: JSON.stringify(body),
        });

      expect((await trigger({ fromTemplate: "base" }, "other")).status).toBe(404);
      expect((await trigger({ steps: [] })).status).toBe(400);
      expect((await trigger({ fromTemplate: "base", fromImage: "ubuntu" })).status).toBe(400);
      expect(
        (await trigger({ fromTemplate: "base", steps: [{ type: "COPY", args: ["a", "/a"], filesHash: "b".repeat(64) }] }))
          .status
      ).toBe(400);
      expect(
        (await trigger({ fromImage: "ubuntu", fromImageRegistry: { type: "aws" } })).status
      ).toBe(400);
      expect(cube.requests).toHaveLength(0);
    } finally {
      await shim.close();
      await cube.close();
    }
  });

  it("runs E2B steps in a build sandbox, snapshots it and serves the result by name", async () => {
    const cube = await fakeCube();
    const envd = await startFakeEnvd();
    const shim = await startShim(cube.url, { cubeProxyUrl: envd.url });
    const hash = "c".repeat(64);
    try {
      const { templateID, buildID } = await (
        await api(shim, "/v3/templates", { method: "POST", body: JSON.stringify({ name: "my-app" }) })
      ).json();
      const link = await (await api(shim, `/templates/my-app/files/${hash}`)).json();
      await fetch(link.url, { method: "PUT", body: "tar-bytes" });

      const trigger = await api(shim, `/v2/templates/${templateID}/builds/${buildID}`, {
        method: "POST",
        body: JSON.stringify({
          fromTemplate: "base",
          steps: [
            { type: "RUN", args: ["apt-get install -y curl"] },
            { type: "ENV", args: ["APP_ENV", "production"] },
            { type: "USER", args: ["app", "true"] },
            { type: "WORKDIR", args: ["/srv/app"] },
            { type: "COPY", args: ["src/", "./", "", "0755"], filesHash: hash },
            { type: "RUN", args: ["npm ci", "root"] },
          ],
          startCmd: "npm start",
          readyCmd: "curl -sf localhost:3000",
        }),
      });
      expect(trigger.status).toBe(202);

      const status = await waitForBuild(shim, templateID, buildID);
      expect(status.status).toBe("ready");
      expect(status.logEntries.some((e: { message: string }) => e.message.includes("[1/6] RUN"))).toBe(true);

      // Build sandbox came from the resolved base and was cleaned up.
      const create = cube.requests.find((r) => r.method === "POST" && r.path === "/sandboxes");
      expect(JSON.parse(create?.body ?? "{}").templateID).toBe("tpl-base");
      expect(cube.requests.some((r) => r.method === "DELETE" && r.path === "/sandboxes/buildsbx1")).toBe(true);

      // Steps ran with E2B's context rules.
      const run1 = envd.commands.find((c) => c.command === "apt-get install -y curl");
      expect(run1).toMatchObject({ user: "root" });
      const run2 = envd.commands.find((c) => c.command === "npm ci");
      expect(run2).toMatchObject({ user: "root", cwd: "/srv/app", envs: { APP_ENV: "production" } });
      expect(envd.commands.some((c) => c.command.includes("useradd --create-home --shell /bin/bash 'app'"))).toBe(true);
      expect(envd.commands.some((c) => c.command.includes("NOPASSWD"))).toBe(true);
      expect(envd.commands.some((c) => c.command.includes(`sourcePath='/tmp/${hash}/unpack/src'`))).toBe(true);
      expect(envd.uploads).toEqual([`/tmp/${hash}.tar`]);
      const start = envd.commands.find((c) => c.command === "npm start");
      expect(start).toMatchObject({ user: "app", cwd: "/srv/app" });
      expect(envd.commands.some((c) => c.command === "curl -sf localhost:3000")).toBe(true);
      // Final context is baked into envd before the snapshot.
      expect(envd.inits).toEqual([
        { envVars: { APP_ENV: "production" }, defaultUser: "app", defaultWorkdir: "/srv/app" },
      ]);

      // The name now resolves to the snapshot everywhere the SDK looks.
      const alias = await api(shim, "/templates/aliases/my-app");
      expect(await alias.json()).toEqual({ templateID: "my-app", public: false });
      const sandbox = await api(shim, "/v2/sandboxes", {
        method: "POST",
        body: JSON.stringify({ templateID: "my-app" }),
      });
      expect(sandbox.status).toBe(201);
      const userCreate = cube.requests.filter((r) => r.method === "POST" && r.path === "/sandboxes").at(-1);
      expect(JSON.parse(userCreate?.body ?? "{}").templateID).toBe("snap-built-1");

      // Build sandboxes never show up in the user's sandbox list.
      const listed = await (await api(shim, "/v2/sandboxes")).json();
      expect(listed.map((s: { sandboxID: string }) => s.sandboxID)).toEqual([SANDBOX_ID]);

      // Deleting by name removes the Cube template and the mapping.
      expect((await api(shim, "/templates/my-app", { method: "DELETE" })).status).toBe(204);
      expect(cube.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/templates/snap-built-1" });
      expect((await api(shim, "/templates/aliases/my-app")).status).toBe(404);
    } finally {
      await shim.close();
      await envd.close();
      await cube.close();
    }
  });

  async function build(shim: RunningShim, name: string, tags?: string[]) {
    const { templateID, buildID } = await (
      await api(shim, "/v3/templates", { method: "POST", body: JSON.stringify({ name, tags }) })
    ).json();
    await api(shim, `/v2/templates/${templateID}/builds/${buildID}`, {
      method: "POST",
      body: JSON.stringify({ fromTemplate: "base", steps: [{ type: "RUN", args: ["echo hi"] }] }),
    });
    const status = await waitForBuild(shim, templateID, buildID);
    expect(status.status).toBe("ready");
    return buildID as string;
  }

  it("manages tags: build tags, assignment, removal and retirement of unreferenced builds", async () => {
    const cube = await fakeCube();
    const envd = await startFakeEnvd();
    const shim = await startShim(cube.url, { cubeProxyUrl: envd.url });
    try {
      const build1 = await build(shim, "tagged", ["v1"]);
      expect((await api(shim, "/templates/aliases/tagged:v1")).status).toBe(200);
      expect((await api(shim, "/templates/aliases/tagged")).status).toBe(404); // no default tag yet

      const assigned = await api(shim, "/templates/tags", {
        method: "POST",
        body: JSON.stringify({ target: "tagged:v1", tags: ["default", "stable"] }),
      });
      expect(assigned.status).toBe(201);
      expect(await assigned.json()).toEqual({ tags: ["default", "stable"], buildID: build1 });
      const tags = await (await api(shim, "/templates/tagged/tags")).json();
      expect(tags.map((t: { tag: string }) => t.tag).sort()).toEqual(["default", "stable", "v1"]);

      // A new default build keeps build1 alive while v1/stable still point at it.
      const build2 = await build(shim, "tagged");
      expect(cube.requests.some((r) => r.method === "DELETE" && r.path === "/templates/snap-built-1")).toBe(false);
      const created = await api(shim, "/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tagged" }) });
      expect(created.status).toBe(201);
      expect(JSON.parse(cube.requests.filter((r) => r.path === "/sandboxes").at(-1)!.body).templateID).toBe(
        "snap-built-2"
      );

      const removed = await api(shim, "/templates/tags", {
        method: "DELETE",
        body: JSON.stringify({ name: "tagged", tags: ["v1", "stable"] }),
      });
      expect(removed.status).toBe(204);
      expect(cube.requests.some((r) => r.method === "DELETE" && r.path === "/templates/snap-built-1")).toBe(true);
      expect(
        (await api(shim, "/templates/tags", { method: "DELETE", body: JSON.stringify({ name: "nope", tags: ["x"] }) }))
          .status
      ).toBe(404);

      // Cube-native templates expose their single build as the default tag.
      expect(await (await api(shim, "/templates/base/tags")).json()).toEqual([
        { tag: "default", buildID: "job-base", createdAt: "2026-09-01T00:00:00Z" },
      ]);
      expect(build2).not.toBe(build1);
    } finally {
      await shim.close();
      await envd.close();
      await cube.close();
    }
  });

  it("lists, describes and updates templates in E2B's shapes", async () => {
    const cube = await fakeCube();
    const envd = await startFakeEnvd();
    const shim = await startShim(cube.url, { cubeProxyUrl: envd.url });
    try {
      const buildID = await build(shim, "catalog");
      await api(shim, "/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "catalog" }) });

      const listed = await (await api(shim, "/templates")).json();
      // The build snapshot (snap-built-1) is an internal artifact, not a template.
      expect(listed.map((t: { templateID: string }) => t.templateID).sort()).toEqual(["catalog", "tpl-base"]);
      const base = listed.find((t: { templateID: string }) => t.templateID === "tpl-base");
      expect(base).toMatchObject({
        buildID: "job-base",
        cpuCount: 4,
        memoryMB: 2048,
        diskSizeMB: 8192,
        names: ["base"],
        buildStatus: "ready",
        public: false,
        createdBy: null,
      });
      const catalog = listed.find((t: { templateID: string }) => t.templateID === "catalog");
      expect(catalog).toMatchObject({ buildID, names: ["catalog"], spawnCount: 1, buildCount: 1, buildStatus: "ready" });
      expect(catalog.lastSpawnedAt).toBeTruthy();

      const page = await api(shim, "/v2/templates?limit=1");
      expect(await page.json()).toHaveLength(1);
      expect(page.headers.get("x-next-token")).toBeTruthy();

      const detail = await (await api(shim, "/templates/catalog")).json();
      expect(detail).toMatchObject({ templateID: "catalog", spawnCount: 1 });
      expect(detail.builds).toEqual([
        expect.objectContaining({ buildID, status: "ready", cpuCount: 2, memoryMB: 512 }),
      ]);
      const cubeDetail = await (await api(shim, "/templates/base")).json();
      expect(cubeDetail.builds).toEqual([expect.objectContaining({ buildID: "job-base", cpuCount: 4 })]);

      const patched = await api(shim, "/v2/templates/catalog", { method: "PATCH", body: JSON.stringify({ public: true }) });
      expect(await patched.json()).toEqual({ names: ["catalog"] });
      expect((await (await api(shim, "/templates/catalog")).json()).public).toBe(true);
      expect(
        (await api(shim, "/templates/base", { method: "PATCH", body: JSON.stringify({ public: true }) })).status
      ).toBe(200);

      const logs = await (await api(shim, `/templates/catalog/builds/${buildID}/logs?level=info`)).json();
      expect(logs.logs.some((e: { message: string }) => e.message.includes("[1/1] RUN"))).toBe(true);
      const backward = await (await api(shim, `/templates/catalog/builds/${buildID}/logs?direction=backward&limit=1`)).json();
      expect(backward.logs).toHaveLength(1);

      expect((await api(shim, "/templates/catalog", { method: "DELETE" })).status).toBe(204);
      expect(cube.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/templates/snap-built-1" });
      expect((await api(shim, "/templates/catalog/tags")).status).toBe(404);
    } finally {
      await shim.close();
      await envd.close();
      await cube.close();
    }
  });

  it("reports the failing step and cleans up when a command fails", async () => {
    const cube = await fakeCube();
    const envd = await startFakeEnvd();
    const shim = await startShim(cube.url, { cubeProxyUrl: envd.url });
    try {
      const { templateID, buildID } = await (
        await api(shim, "/v3/templates", { method: "POST", body: JSON.stringify({ name: "broken" }) })
      ).json();
      await api(shim, `/v2/templates/${templateID}/builds/${buildID}`, {
        method: "POST",
        body: JSON.stringify({
          fromTemplate: "base",
          steps: [
            { type: "RUN", args: ["echo fine"] },
            { type: "RUN", args: ["exit 1"] },
          ],
        }),
      });
      const status = await waitForBuild(shim, templateID, buildID);
      expect(status.status).toBe("error");
      expect(status.reason).toMatchObject({ step: "2" });
      expect(status.reason.message).toContain("exited with code 1");
      expect(cube.requests.some((r) => r.path.endsWith("/snapshots"))).toBe(false);
      expect(cube.requests.at(-1)).toMatchObject({ method: "DELETE", path: "/sandboxes/buildsbx1" });
      expect((await api(shim, "/templates/aliases/broken")).status).toBe(404);
    } finally {
      await shim.close();
      await envd.close();
      await cube.close();
    }
  });

  it("build status falls back to Cube for builds Cube started itself", async () => {
    const upstream = await startMockUpstream((req) => {
      if (req.method === "GET" && req.path === "/templates/tpl-built") {
        return { status: 200, body: { templateID: "tpl-built", jobID: "job-1", status: "READY" } };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url);
    try {
      const res = await fetch(`${shim.url}/templates/tpl-built/builds/job-1/status`, {
        headers: { "X-API-Key": TEST_API_KEY },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: "ready", templateID: "tpl-built", buildID: "job-1" });
    } finally {
      await shim.close();
      await upstream.close();
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

describe("envd access token enforcement", () => {
  let upstream: MockUpstream;
  let shim: RunningShim;

  beforeEach(async () => {
    upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes") {
        const templateID = JSON.parse(req.body).templateID;
        return { status: 201, body: cubeCreated({ templateID }) };
      }
      if (req.method === "GET" && req.path === `/sandboxes/${SANDBOX_ID}`) {
        return { status: 200, body: cubeDetail() };
      }
      if (req.method === "POST" && req.path === `/sandboxes/${SANDBOX_ID}/snapshots`) {
        return { status: 201, body: { snapshotID: "snapshot-7", names: [] } };
      }
      if (req.method === "DELETE" && req.path === "/templates/snapshot-7") return { status: 204 };
      if (req.method === "DELETE" && req.path === `/sandboxes/${SANDBOX_ID}`) return { status: 204 };
      return undefined;
    });
    shim = await startShim(upstream.url);
  });
  afterEach(async () => {
    await shim.close();
    await upstream.close();
  });

  const post = (path: string, body: unknown) =>
    fetch(`${shim.url}${path}`, {
      method: "POST",
      headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const inits = () => (shim.envd?.requests ?? []).filter((r) => r.path === "/init");

  it("writes the minted token into envd even without envVars", async () => {
    const res = await post("/v2/sandboxes", { templateID: "tpl-x" });
    const { envdAccessToken } = await res.json();
    expect(inits()).toHaveLength(1);
    expect(inits()[0].headers.host).toBe(`49983-${SANDBOX_ID}.cube.app`);
    expect(JSON.parse(inits()[0].body)).toEqual({ accessToken: envdAccessToken });
  });

  it("leaves envd alone for an insecure v1 create without envVars", async () => {
    const res = await post("/sandboxes", { templateID: "tpl-x" });
    expect(res.status).toBe(201);
    expect(inits()).toHaveLength(0);
  });

  it("refuses and cleans up a sandbox whose envd already holds a foreign token", async () => {
    await shim.close();
    const envd = await startMockUpstream(() => ({ status: 401, body: "access token validation failed" }));
    shim = await startShim(upstream.url, { cubeProxyUrl: envd.url });
    try {
      const res = await post("/v2/sandboxes", { templateID: "tpl-x" });
      expect(res.status).toBe(409);
      expect(envd.requests).toHaveLength(1); // a token conflict is not retried
      expect(upstream.requests.at(-1)).toMatchObject({
        method: "DELETE",
        path: `/sandboxes/${SANDBOX_ID}`,
      });
      expect(shim.store.getSandbox(SANDBOX_ID)).toBeNull();
    } finally {
      await envd.close();
    }
  });

  it("retries envd init while the VM is still starting", async () => {
    await shim.close();
    let calls = 0;
    const envd = await startMockUpstream(() => (++calls < 3 ? { status: 502 } : { status: 204 }));
    shim = await startShim(upstream.url, { cubeProxyUrl: envd.url });
    try {
      const res = await post("/v2/sandboxes", { templateID: "tpl-x" });
      expect(res.status).toBe(201);
      expect(calls).toBe(3);
    } finally {
      await envd.close();
    }
  });

  it("hands out the snapshot source token for sandboxes restored from a shim snapshot", async () => {
    const source = await post("/v2/sandboxes", { templateID: "tpl-x" });
    const sourceToken = (await source.json()).envdAccessToken;

    const snap = await post(`/sandboxes/${SANDBOX_ID}/snapshots`, { name: "ckpt" });
    expect(snap.status).toBe(201);
    expect(shim.store.getSnapshotToken("snapshot-7")).toBe(sourceToken);

    // Even an insecure v1 create restores an envd that enforces the token.
    const restored = await post("/sandboxes", { templateID: "snapshot-7" });
    expect(restored.status).toBe(201);
    expect((await restored.json()).envdAccessToken).toBe(sourceToken);
    // The snapshot ID is not treated as an alias (no GET /templates lookup).
    expect(upstream.requests.some((r) => r.method === "GET" && r.path === "/templates")).toBe(false);
    expect(JSON.parse(inits().at(-1)?.body ?? "{}")).toEqual({ accessToken: sourceToken });

    const del = await fetch(`${shim.url}/templates/snapshot-7`, {
      method: "DELETE",
      headers: { "X-API-Key": TEST_API_KEY },
    });
    expect(del.status).toBe(204);
    expect(shim.store.getSnapshotToken("snapshot-7")).toBeNull();
  });

  it("authenticates the shim's own envd metrics reads", async () => {
    const res = await post("/v2/sandboxes", { templateID: "tpl-x" });
    const { envdAccessToken } = await res.json();
    await fetch(`${shim.url}/sandboxes/${SANDBOX_ID}/metrics`, {
      headers: { "X-API-Key": TEST_API_KEY },
    });
    const metrics = (shim.envd?.requests ?? []).find((r) => r.path === "/metrics");
    expect(metrics?.headers["x-access-token"]).toBe(envdAccessToken);
  });
});
