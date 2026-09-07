import { describe, it, expect } from "vitest";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { parseEdgeHeaders, parseEdgeHost, isEnvdAuthorized } from "./edge-surface.js";
import { fileSignature } from "./auth.js";
import { ShimStore } from "./store.js";
import { startMockUpstream, startShim, TEST_API_KEY } from "./test-helpers.js";
import type { ShimConfig } from "./config.js";

describe("parseEdgeHost", () => {
  it("parses <port>-<id>.<domain>", () => {
    expect(parseEdgeHost("49983-abc123.sb.test", "sb.test")).toEqual({
      port: 49983,
      sandboxId: "abc123",
    });
  });
  it("parses the stable sandbox.<domain> entry", () => {
    expect(parseEdgeHost("sandbox.sb.test", "sb.test")).toEqual({ port: -1, sandboxId: "" });
  });
  it("rejects foreign hosts", () => {
    expect(parseEdgeHost("cubeapi.example.org", "sb.test")).toBeNull();
    expect(parseEdgeHost("49983-abc.sb.test", "")).toBeNull();
    expect(parseEdgeHost(undefined, "sb.test")).toBeNull();
  });
  it("strips the host port suffix", () => {
    expect(parseEdgeHost("49983-abc123.sb.test:443", "sb.test")).toEqual({
      port: 49983,
      sandboxId: "abc123",
    });
  });
});

describe("parseEdgeHeaders", () => {
  it("parses the official stable sandbox gateway headers", () => {
    expect(
      parseEdgeHeaders({
        "e2b-sandbox-id": "abc123",
        "e2b-sandbox-port": "49983",
      })
    ).toEqual({ port: 49983, sandboxId: "abc123" });
  });

  it("rejects malformed ids and ports", () => {
    expect(
      parseEdgeHeaders({ "e2b-sandbox-id": "bad-id", "e2b-sandbox-port": "49983" })
    ).toBeNull();
    expect(
      parseEdgeHeaders({ "e2b-sandbox-id": "abc123", "e2b-sandbox-port": "70000" })
    ).toBeNull();
    expect(
      parseEdgeHeaders({ "e2b-sandbox-id": "abc123", "e2b-sandbox-port": "49983x" })
    ).toBeNull();
  });
});

describe("isEnvdAuthorized", () => {
  function ctxWith(token: string | null): { store: ShimStore; config: ShimConfig } {
    const store = new ShimStore(":memory:");
    store.recordSandbox({
      sandboxId: "abc",
      templateId: "tpl",
      createdAtMs: Date.now(),
      timeoutSeconds: null,
      autoPause: false,
      envdToken: token,
    });
    return { store, config: { cubeDomain: "cube.app" } as ShimConfig };
  }

  const fakeReq = (method: string, headers: Record<string, string> = {}) =>
    ({ method, headers }) as unknown as IncomingMessage;

  it("allows anonymous envd for non-secure sandboxes", () => {
    const ctx = ctxWith(null);
    expect(isEnvdAuthorized(ctx, fakeReq("GET"), new URL("http://x/files"), "abc")).toBe(true);
  });

  it("denies unknown sandboxes", () => {
    const ctx = ctxWith("v1_token");
    expect(isEnvdAuthorized(ctx, fakeReq("GET"), new URL("http://x/files"), "unknown")).toBe(false);
  });

  it("accepts the X-Access-Token header", () => {
    const ctx = ctxWith("v1_secret");
    const req = fakeReq("POST", { "x-access-token": "v1_secret" });
    expect(isEnvdAuthorized(ctx, req, new URL("http://x/files"), "abc")).toBe(true);
  });

  it("rejects wrong tokens", () => {
    const ctx = ctxWith("v1_secret");
    const req = fakeReq("POST", { "x-access-token": "v1_wrong" });
    expect(isEnvdAuthorized(ctx, req, new URL("http://x/files"), "abc")).toBe(false);
  });

  it("accepts a valid presigned URL signature", () => {
    const ctx = ctxWith("v1_secret");
    const path = "/tmp/oi-session.env";
    const exp = Math.floor(Date.now() / 1000) + 600;
    const sig = fileSignature(path, "write", "user", "v1_secret", exp);
    const url = new URL(
      `http://x/files?path=${encodeURIComponent(path)}&username=user&signature=${encodeURIComponent(sig)}&signature_expiration=${exp}`
    );
    expect(isEnvdAuthorized(ctx, fakeReq("POST"), url, "abc")).toBe(true);
  });

  it("rejects expired signatures", () => {
    const ctx = ctxWith("v1_secret");
    const exp = Math.floor(Date.now() / 1000) - 10;
    const sig = fileSignature("/tmp/f", "read", "user", "v1_secret", exp);
    const url = new URL(`http://x/files?path=/tmp/f&signature=${sig}&signature_expiration=${exp}`);
    expect(isEnvdAuthorized(ctx, fakeReq("GET"), url, "abc")).toBe(false);
  });
});

describe("edge proxy integration", () => {
  it("proxies envd traffic with rewritten Host and strips the shim token", async () => {
    // Mock cube-proxy capturing the Host header it receives.
    const seen: { host?: string; xAccessToken?: string; path?: string } = {};
    const proxy = http.createServer((req, res) => {
      seen.host = req.headers.host;
      seen.xAccessToken = req.headers["x-access-token"] as string | undefined;
      seen.path = req.url;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxyPort = (proxy.address() as AddressInfo).port;

    const upstream = await startMockUpstream((req) => {
      if (req.method === "POST" && req.path === "/sandboxes") {
        return {
          status: 201,
          body: {
            sandboxID: "edge1",
            templateID: "tpl-x",
            domain: "cube.app",
            envdVersion: "0.2.0",
          },
        };
      }
      if (req.method === "GET" && req.path === "/sandboxes/edge1") {
        return { status: 200, body: { sandboxID: "edge1", state: "running" } };
      }
      return undefined;
    });
    const shim = await startShim(upstream.url, { cubeProxyUrl: `http://127.0.0.1:${proxyPort}` });

    try {
      // Create a secure sandbox so the store holds a token.
      const create = await fetch(`${shim.url}/sandboxes`, {
        method: "POST",
        headers: { "X-API-Key": TEST_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ templateID: "tpl-x", secure: true }),
      });
      const { envdAccessToken } = await create.json();

      const edgeCall = (
        headers: Record<string, string>,
        path = "/files?path=/tmp/x&username=user"
      ) =>
        new Promise<{ status: number; body: string }>((resolve, reject) => {
          const req = http.request(
            `${shim.url}${path}`,
            { method: "POST", headers: { Host: "49983-edge1.sb.test", ...headers } },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (c) => chunks.push(c));
              res.on("end", () =>
                resolve({
                  status: res.statusCode ?? 0,
                  body: Buffer.concat(chunks).toString("utf8"),
                })
              );
            }
          );
          req.on("error", reject);
          req.end("payload");
        });

      // No token → 401, never reaches cube-proxy.
      const denied = await edgeCall({});
      expect(denied.status).toBe(401);
      expect(seen.host).toBeUndefined();

      // envd x-internal endpoints are refused even with a valid token.
      const internal = await edgeCall({ "X-Access-Token": envdAccessToken }, "/init");
      expect(internal.status).toBe(403);
      const upgrade = await edgeCall({ "X-Access-Token": envdAccessToken }, "/upgrade");
      expect(upgrade.status).toBe(403);

      // Valid token → proxied with Cube-domain Host, token header stripped.
      const allowed = await edgeCall({ "X-Access-Token": envdAccessToken });
      expect(allowed.status).toBe(200);
      expect(seen.host).toBe("49983-edge1.cube.app");
      expect(seen.xAccessToken).toBeUndefined();
      expect(seen.path).toBe("/files?path=/tmp/x&username=user");

      // Official SDKs use this form when E2B_SANDBOX_URL points at the same
      // stable gateway hostname as E2B_API_URL.
      const stable = await edgeCall({
        Host: "cubeapi.test",
        "X-Access-Token": envdAccessToken,
        "E2b-Sandbox-Id": "edge1",
        "E2b-Sandbox-Port": "49983",
      });
      expect(stable.status).toBe(200);
      expect(seen.host).toBe("49983-edge1.cube.app");
    } finally {
      await shim.close();
      await upstream.close();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });
});
