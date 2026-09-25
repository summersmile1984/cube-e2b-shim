/**
 * Regression guard: every operation in E2B's public OpenAPI specs
 * (e2b-dev/E2B spec/openapi.yml and spec/openapi-volumecontent.yml, SDK
 * 2.51.0) must be routed by the shim, authenticated with the scheme E2B
 * declares for it. "Routed" means the shim did not fall through to its
 * catch-all 404 - handlers may still answer 4xx for the dummy inputs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

// [method, path, auth] generated from the specs.
const OPERATIONS: Array<[string, string, string]> = [
  ["GET", "/health", "none"],
  ["GET", "/teams", "accessToken"],
  ["GET", "/teams/{teamID}/metrics", "apiKey"],
  ["GET", "/teams/{teamID}/metrics/max", "apiKey"],
  ["GET", "/sandboxes", "apiKey"],
  ["POST", "/sandboxes", "apiKey"],
  ["POST", "/v2/sandboxes", "apiKey"],
  ["GET", "/v2/sandboxes", "apiKey"],
  ["GET", "/sandboxes/metrics", "apiKey"],
  ["GET", "/sandboxes/{sandboxID}/logs", "apiKey"],
  ["GET", "/v2/sandboxes/{sandboxID}/logs", "apiKey"],
  ["GET", "/sandboxes/{sandboxID}", "apiKey"],
  ["DELETE", "/sandboxes/{sandboxID}", "apiKey"],
  ["GET", "/sandboxes/{sandboxID}/metrics", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/pause", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/resume", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/fork", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/connect", "apiKey"],
  ["POST", "/v2/sandboxes/{sandboxID}/connect", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/timeout", "apiKey"],
  ["PUT", "/sandboxes/{sandboxID}/network", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/refreshes", "apiKey"],
  ["POST", "/sandboxes/{sandboxID}/snapshots", "apiKey"],
  ["GET", "/snapshots", "apiKey"],
  ["POST", "/v3/templates", "apiKey"],
  ["GET", "/v2/templates", "apiKey"],
  ["GET", "/templates/{templateID}/files/{hash}", "apiKey"],
  ["GET", "/templates", "apiKey"],
  ["GET", "/templates/{templateID}", "apiKey"],
  ["DELETE", "/templates/{templateID}", "apiKey"],
  ["PATCH", "/templates/{templateID}", "apiKey"],
  ["POST", "/v2/templates/{templateID}/builds/{buildID}", "apiKey"],
  ["PATCH", "/v2/templates/{templateID}", "apiKey"],
  ["GET", "/templates/{templateID}/builds/{buildID}/status", "apiKey"],
  ["GET", "/templates/{templateID}/builds/{buildID}/logs", "apiKey"],
  ["POST", "/templates/tags", "apiKey"],
  ["DELETE", "/templates/tags", "apiKey"],
  ["GET", "/templates/{templateID}/tags", "apiKey"],
  ["GET", "/templates/aliases/{alias}", "apiKey"],
  ["GET", "/nodes", "admin"],
  ["GET", "/nodes/{nodeID}", "admin"],
  ["POST", "/nodes/{nodeID}", "admin"],
  ["POST", "/admin/teams/{teamID}/sandboxes/kill", "admin"],
  ["GET", "/admin/sandboxes/running-counts", "admin"],
  ["POST", "/admin/teams/{teamID}/builds/cancel", "admin"],
  ["POST", "/admin/teams/{teamID}/api-keys", "admin"],
  ["DELETE", "/admin/teams/{teamID}/api-keys/{apiKeyID}", "admin"],
  ["GET", "/api-keys", "accessToken"],
  ["POST", "/api-keys", "accessToken"],
  ["PATCH", "/api-keys/{apiKeyID}", "accessToken"],
  ["DELETE", "/api-keys/{apiKeyID}", "accessToken"],
  ["GET", "/volumes", "apiKey"],
  ["POST", "/volumes", "apiKey"],
  ["GET", "/volumes/{volumeID}", "apiKey"],
  ["DELETE", "/volumes/{volumeID}", "apiKey"],
  ["GET", "/secrets", "apiKey"],
  ["POST", "/secrets", "apiKey"],
  ["GET", "/secrets/{secretID}", "apiKey"],
  ["POST", "/secrets/{secretID}", "apiKey"],
  ["DELETE", "/secrets/{secretID}", "apiKey"],
  ["GET", "/clusters/{clusterID}/rigs", "admin"],
  ["PUT", "/clusters/{clusterID}/rigs/{rigID}/capacity", "admin"],
  ["DELETE", "/clusters/{clusterID}/rigs/instances/{instanceID}", "admin"],
  ["GET", "/clusters/{clusterID}/rigs/{rigID}/instances", "admin"],
  ["GET", "/clusters/{clusterID}/rigs/{rigID}/errors", "admin"],
  ["GET", "/events/sandboxes/{sandboxID}", "apiKey"],
  ["GET", "/events/sandboxes", "apiKey"],
  ["POST", "/events/webhooks", "apiKey"],
  ["GET", "/events/webhooks", "apiKey"],
  ["GET", "/events/webhooks/{webhookID}", "apiKey"],
  ["PATCH", "/events/webhooks/{webhookID}", "apiKey"],
  ["DELETE", "/events/webhooks/{webhookID}", "apiKey"],
  ["GET", "/events/webhooks/{webhookID}/deliveries", "apiKey"],
  ["GET", "/events/webhooks/{webhookID}/stats", "apiKey"],
  ["GET", "/volumecontent/{volumeID}/path", "volume"],
  ["PATCH", "/volumecontent/{volumeID}/path", "volume"],
  ["DELETE", "/volumecontent/{volumeID}/path", "volume"],
  ["GET", "/volumecontent/{volumeID}/dir", "volume"],
  ["POST", "/volumecontent/{volumeID}/dir", "volume"],
  ["GET", "/volumecontent/{volumeID}/file", "volume"],
  ["PUT", "/volumecontent/{volumeID}/file", "volume"],
];

let cube: MockUpstream;
let shim: RunningShim;

beforeAll(async () => {
  // A permissive Cube: lists are empty, everything else "exists".
  cube = await startMockUpstream((req) => {
    if (req.method === "GET" && (req.path.startsWith("/v2/sandboxes") || req.path === "/templates" || req.path === "/volumes" || req.path.startsWith("/snapshots"))) {
      return { status: 200, body: [] };
    }
    return { status: 200, body: { sandboxID: "sbx", templateID: "tpl-x", volumeID: "vol", name: "vol", status: "READY" } };
  });
  shim = await startShim(cube.url);
});
afterAll(async () => {
  await shim.close();
  await cube.close();
});

function concrete(path: string): string {
  return path
    .replace("{teamID}", TEST_TEAM_ID)
    .replace(/\{[^}]+\}/g, (param) => (param === "{hash}" ? "a".repeat(64) : "x1"))
    .concat(path.startsWith("/volumecontent") ? "?path=/" : "");
}

describe("E2B OpenAPI coverage", () => {
  it("covers all 81 operations of the current public specs", () => {
    expect(OPERATIONS).toHaveLength(81);
  });

  it.each(OPERATIONS)("%s %s is implemented", async (method, path, auth) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (auth === "apiKey") headers["X-API-Key"] = TEST_API_KEY;
    if (auth === "accessToken") headers.Authorization = `Bearer ${TEST_ACCESS_TOKEN}`;
    if (auth === "admin") headers["X-Admin-Token"] = TEST_ADMIN_TOKEN;
    if (auth === "volume") headers.Authorization = "Bearer vol_invalid";
    const res = await fetch(`${shim.url}${concrete(path)}`, {
      method,
      headers,
      ...(method === "GET" || method === "DELETE" ? {} : { body: "{}" }),
    });
    const text = await res.text();
    expect(text, `${method} ${path} fell through to the catch-all`).not.toMatch(/"Not found: /);
    expect(res.status, `${method} ${path}: ${text}`).not.toBe(405);
    if (auth !== "volume") expect(res.status, `${method} ${path} rejected its declared auth`).not.toBe(401);
  });
});
