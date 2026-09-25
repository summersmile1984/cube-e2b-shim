import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startMockUpstream,
  startShim,
  TEST_API_KEY,
  type MockUpstream,
  type RunningShim,
} from "./test-helpers.js";

let cube: MockUpstream;
let shim: RunningShim;

beforeEach(async () => {
  cube = await startMockUpstream((req) => {
    if (req.method === "POST" && req.path === "/sandboxes") {
      return { status: 201, body: { sandboxID: "sbx1", templateID: "tpl-x", envdVersion: "0.5.13" } };
    }
    if (req.method === "GET" && req.path === "/sandboxes/sbx1") {
      // Cube echoes the network it enforces, with secret values resolved.
      const create = cube.requests.find((r) => r.method === "POST" && r.path === "/sandboxes");
      return { status: 200, body: { sandboxID: "sbx1", state: "running", network: JSON.parse(create!.body).network } };
    }
    if (req.method === "PUT" && req.path === "/sandboxes/sbx1/network") return { status: 204 };
    return undefined;
  });
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

describe("secrets API", () => {
  it("creates, reads, versions, lists and deletes secrets without ever returning values", async () => {
    const created = await api("/secrets", {
      method: "POST",
      body: JSON.stringify({ name: "OpenAI_Key", value: "sk-live-123", metadata: { team: "ml" } }),
    });
    expect(created.status).toBe(201);
    const secret = await created.json();
    expect(secret).toMatchObject({ name: "openai_key", currentVersion: 1, metadata: { team: "ml" } });
    expect(secret.secretID).toMatch(/^sec_[0-9a-f]{32}$/);
    expect(JSON.stringify(secret)).not.toContain("sk-live-123");

    expect((await api("/secrets/openai_key")).status).toBe(200);
    expect((await api(`/secrets/${secret.secretID}`)).status).toBe(200);
    expect(
      (await api("/secrets", { method: "POST", body: JSON.stringify({ name: "openai_key", value: "x" }) })).status
    ).toBe(409);

    const updated = await (
      await api(`/secrets/${secret.secretID}`, { method: "POST", body: JSON.stringify({ value: "sk-live-456" }) })
    ).json();
    expect(updated).toMatchObject({ currentVersion: 2, metadata: { team: "ml" } });

    for (const name of ["b", "c"]) {
      await api("/secrets", { method: "POST", body: JSON.stringify({ name, value: "v" }) });
    }
    const page1 = await api("/secrets?limit=2");
    expect(await page1.json()).toHaveLength(2);
    const next = page1.headers.get("x-next-token");
    expect(next).toBeTruthy();
    expect(await (await api(`/secrets?limit=2&nextToken=${next}`)).json()).toHaveLength(1);

    expect((await api(`/secrets/${secret.secretID}`, { method: "DELETE" })).status).toBe(204);
    expect((await api("/secrets/openai_key")).status).toBe(404);
  });

  it("validates names and metadata", async () => {
    const post = (body: unknown) => api("/secrets", { method: "POST", body: JSON.stringify(body) });
    expect((await post({ name: "bad name", value: "v" })).status).toBe(400);
    expect((await post({ name: "sec_x", value: "v" })).status).toBe(400);
    expect((await post({ name: "ok", value: "v", metadata: { a: 1 } })).status).toBe(400);
  });
});

describe("secret placeholders in network rules", () => {
  it("resolves ${e2b.secrets.*} for Cube and shows callers only the placeholder", async () => {
    await api("/secrets", { method: "POST", body: JSON.stringify({ name: "gh", value: "ghp_secret" }) });
    const network = {
      allowOut: ["api.github.com"],
      rules: {
        "api.github.com": [{ transform: { headers: { Authorization: "Bearer ${e2b.secrets.gh}" } } }],
      },
    };
    const created = await api("/v2/sandboxes", {
      method: "POST",
      body: JSON.stringify({ templateID: "tpl-x", network }),
    });
    expect(created.status).toBe(201);

    const forwarded = JSON.parse(cube.requests.find((r) => r.path === "/sandboxes")!.body);
    expect(forwarded.network.rules["api.github.com"][0].transform.headers.Authorization).toBe("Bearer ghp_secret");

    const detail = await (await api("/sandboxes/sbx1")).json();
    expect(detail.network).toEqual(network);
    expect(JSON.stringify(detail)).not.toContain("ghp_secret");

    await api("/sandboxes/sbx1/network", {
      method: "PUT",
      body: JSON.stringify({ rules: { "x.com": [{ transform: { headers: { K: "${e2b.secrets.gh}" } } }] } }),
    });
    const put = cube.requests.find((r) => r.method === "PUT")!;
    expect(JSON.parse(put.body).rules["x.com"][0].transform.headers.K).toBe("ghp_secret");

    const unknown = await api("/v2/sandboxes", {
      method: "POST",
      body: JSON.stringify({
        templateID: "tpl-x",
        network: { rules: { "x.com": [{ transform: { headers: { K: "${e2b.secrets.missing}" } } }] } },
      }),
    });
    expect(unknown.status).toBe(400);
  });
});
