import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { webhookSignature } from "./events.js";
import {
  startMockUpstream,
  startShim,
  TEST_API_KEY,
  TEST_TEAM_ID,
  type MockUpstream,
  type RunningShim,
} from "./test-helpers.js";

/** A tiny fake Cube whose sandbox list the test can mutate. */
function cubeWith(sandboxes: Map<string, { state: string; templateID: string; metadata?: Record<string, string> }>) {
  return startMockUpstream((req) => {
    if (req.method === "GET" && req.path.startsWith("/v2/sandboxes")) {
      return {
        status: 200,
        body: [...sandboxes].map(([sandboxID, s]) => ({ sandboxID, ...s, clientID: "10.0.0.1" })),
      };
    }
    if (req.method === "POST" && req.path === "/sandboxes") {
      const id = `sbx${sandboxes.size + 1}`;
      sandboxes.set(id, { state: "running", templateID: JSON.parse(req.body).templateID });
      return { status: 201, body: { sandboxID: id, templateID: "tpl-x", envdVersion: "0.5.13" } };
    }
    const kill = /^\/sandboxes\/([^/]+)$/.exec(req.path);
    if (req.method === "DELETE" && kill) {
      sandboxes.delete(kill[1]);
      return { status: 204 };
    }
    const pause = /^\/sandboxes\/([^/]+)\/pause$/.exec(req.path);
    if (req.method === "POST" && pause) {
      sandboxes.get(pause[1])!.state = "paused";
      return { status: 204 };
    }
    if (req.method === "POST" && /\/timeout$/.test(req.path)) return { status: 204 };
    if (req.method === "GET" && /^\/sandboxes\/[^/]+$/.test(req.path)) return { status: 200, body: {} };
    return undefined;
  });
}

let sandboxes: Map<string, { state: string; templateID: string; metadata?: Record<string, string> }>;
let cube: MockUpstream;
let shim: RunningShim;

beforeEach(async () => {
  sandboxes = new Map();
  cube = await cubeWith(sandboxes);
  shim = await startShim(cube.url);
});
afterEach(async () => {
  await shim.close();
  await cube.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${shim.url}${path}`, {
    ...init,
    headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json", ...(init.headers as object) },
  });

describe("sandbox events", () => {
  it("records lifecycle events for API calls in E2B's SandboxEvent shape", async () => {
    const created = await (
      await api("/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tpl-x", metadata: { a: "1" } }) })
    ).json();
    const id = created.sandboxID;
    await api(`/sandboxes/${id}/timeout`, { method: "POST", body: JSON.stringify({ timeout: 60 }) });
    await api(`/sandboxes/${id}/pause`, { method: "POST" });
    await api(`/sandboxes/${id}`, { method: "DELETE" });

    const events = await (await api(`/events/sandboxes/${id}?orderAsc=true`)).json();
    expect(events.map((e: { type: string }) => e.type)).toEqual([
      "sandbox.lifecycle.created",
      "sandbox.lifecycle.updated",
      "sandbox.lifecycle.paused",
      "sandbox.lifecycle.killed",
    ]);
    expect(events[0]).toMatchObject({
      version: "v2",
      sandboxId: id,
      sandboxTemplateId: "tpl-x",
      sandboxTeamId: TEST_TEAM_ID,
      eventData: { sandbox_metadata: { a: "1" } },
    });
    expect(events[0].sandboxExecutionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[1].eventData).toEqual({ set_timeout: 60 });

    const filtered = await (await api("/events/sandboxes?types=sandbox.lifecycle.killed")).json();
    expect(filtered).toHaveLength(1);
    const latestFirst = await (await api("/events/sandboxes?limit=1")).json();
    expect(latestFirst[0].type).toBe("sandbox.lifecycle.killed");
    expect((await api("/events/sandboxes/unknown")).status).toBe(404);
    expect((await api("/events/sandboxes?types=bogus")).status).toBe(400);
  });

  it("detects what Cube does on its own by polling, without a first-run event flood", async () => {
    sandboxes.set("pre1", { state: "running", templateID: "tpl-x" });
    sandboxes.set("build1", { state: "running", templateID: "tpl-x", metadata: { "cube-e2b-shim.build": "b" } });
    await shim.events.poll(); // baseline: existing sandboxes are adopted silently
    expect(await (await api("/events/sandboxes")).json()).toEqual([]);

    sandboxes.get("pre1")!.state = "paused"; // Cube auto-pause
    sandboxes.set("ext1", { state: "running", templateID: "tpl-y" }); // created outside the shim
    await shim.events.poll();
    sandboxes.delete("pre1"); // TTL kill
    await shim.events.poll();

    const events = await (await api("/events/sandboxes?orderAsc=true&limit=100")).json();
    expect(events.map((e: { type: string; sandboxId: string }) => `${e.sandboxId} ${e.type}`)).toEqual([
      "pre1 sandbox.lifecycle.paused",
      "ext1 sandbox.lifecycle.created",
      "pre1 sandbox.lifecycle.killed",
    ]);
  });
});

describe("team metrics", () => {
  it("samples concurrency and start rate, and reports maxima", async () => {
    sandboxes.set("a", { state: "running", templateID: "tpl-x" });
    await shim.events.poll();
    await api("/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tpl-x" }) });
    await api("/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tpl-x" }) });
    await shim.events.poll();

    const metrics = await (await api(`/teams/${TEST_TEAM_ID}/metrics`)).json();
    expect(metrics.length).toBeGreaterThanOrEqual(1);
    expect(metrics.at(-1)).toMatchObject({ concurrentSandboxes: 3 });
    expect(metrics.at(-1).sandboxStartRate).toBeGreaterThan(0);

    const max = await (await api(`/teams/${TEST_TEAM_ID}/metrics/max?metric=concurrent_sandboxes`)).json();
    expect(max.value).toBe(3);
    expect((await api(`/teams/${TEST_TEAM_ID}/metrics/max?metric=nope`)).status).toBe(400);
    expect((await api(`/teams/other/metrics`)).status).toBe(404);
  });
});

describe("webhooks", () => {
  it("delivers signed events, retries failures and reports deliveries and stats", async () => {
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    let failuresLeft = 1;
    const receiver = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (failuresLeft-- > 0) {
          res.writeHead(500);
          return res.end("try again");
        }
        res.writeHead(200);
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
    try {
      const created = await api("/events/webhooks", {
        method: "POST",
        body: JSON.stringify({
          name: "ci",
          url,
          events: ["sandbox.lifecycle.created"],
          signatureSecret: "s3cret",
        }),
      });
      expect(created.status).toBe(201);
      const hook = await created.json();
      expect(hook).toMatchObject({ name: "ci", url, enabled: true, teamId: TEST_TEAM_ID });
      expect(hook.signatureSecret).toBeUndefined();

      await api("/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tpl-x" }) });
      await shim.events.drain();

      expect(received).toHaveLength(2); // one failure, one retry
      const { headers, body } = received[1];
      expect(headers["e2b-signature"]).toBe(webhookSignature("s3cret", body));
      const payload = JSON.parse(body);
      expect(payload).toMatchObject({
        type: "sandbox.lifecycle.created",
        sandbox_id: "sbx1",
        sandbox_team_id: TEST_TEAM_ID,
      });

      const deliveries = await (await api(`/events/webhooks/${hook.id}/deliveries`)).json();
      expect(deliveries.nextCursor).toBeNull();
      expect(deliveries.data).toHaveLength(1);
      expect(deliveries.data[0].attempts.map((a: { status: string }) => a.status)).toEqual(["failed", "success"]);
      expect(deliveries.data[0].attempts[0]).toMatchObject({ errorClass: "http_error", responseHttpStatusCode: 500 });
      expect(deliveries.data[0].attempts[0].requestHeaders).toContain("[REDACTED]");

      const stats = await (await api(`/events/webhooks/${hook.id}/stats`)).json();
      expect(stats).toMatchObject({ total: 2, failed: 1 });
      expect(stats.buckets).toHaveLength(1);

      // Disabled hooks and unsubscribed event types get nothing.
      await api(`/events/webhooks/${hook.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
      await api("/v2/sandboxes", { method: "POST", body: JSON.stringify({ templateID: "tpl-x" }) });
      await shim.events.drain();
      expect(received).toHaveLength(2);

      expect((await (await api("/events/webhooks")).json())).toHaveLength(1);
      expect((await api(`/events/webhooks/${hook.id}`, { method: "DELETE" })).status).toBe(200);
      expect((await api(`/events/webhooks/${hook.id}`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => receiver.close(() => resolve()));
    }
  });

  it("validates webhook registrations", async () => {
    const bad = (body: unknown) => api("/events/webhooks", { method: "POST", body: JSON.stringify(body) });
    expect((await bad({ name: "x", url: "ftp://x", events: ["sandbox.lifecycle.created"], signatureSecret: "s" })).status).toBe(400);
    expect((await bad({ name: "x", url: "https://x", events: ["nope"], signatureSecret: "s" })).status).toBe(400);
    expect((await bad({ name: "x", url: "https://x", events: ["sandbox.lifecycle.created"] })).status).toBe(400);
  });
});
