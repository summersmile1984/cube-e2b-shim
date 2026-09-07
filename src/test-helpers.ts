/**
 * Shared test scaffolding: a programmable mock Cube upstream and a shim
 * server on an ephemeral port.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { createShimServer } from "./server.js";
import { ShimStore } from "./store.js";
import { CubeClient } from "./cube-client.js";
import type { ShimConfig } from "./config.js";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export type MockHandler = (
  req: RecordedRequest
) => { status: number; body?: unknown; headers?: Record<string, string> } | undefined;

export interface MockUpstream {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

export async function startMockUpstream(handler: MockHandler): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const recorded: RecordedRequest = {
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      };
      requests.push(recorded);
      const response = handler(recorded) ?? {
        status: 404,
        body: { code: 404, message: "not found" },
      };
      const payload =
        response.body === undefined
          ? ""
          : typeof response.body === "string"
            ? response.body
            : JSON.stringify(response.body);
      res.writeHead(response.status, {
        "Content-Type": "application/json",
        ...(response.headers ?? {}),
      });
      res.end(payload);
    })().catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export interface RunningShim {
  url: string;
  store: ShimStore;
  config: ShimConfig;
  close: () => Promise<void>;
}

export const TEST_API_KEY = "shim-test-key";

export async function startShim(
  upstreamUrl: string,
  overrides: Partial<ShimConfig> = {}
): Promise<RunningShim> {
  const config: ShimConfig = {
    listenPort: 0,
    apiKeys: [TEST_API_KEY],
    cubeApiUrl: upstreamUrl,
    cubeApiKey: "cube-backend-key",
    shimDomain: "sb.test",
    cubeProxyUrl: "http://127.0.0.1:1",
    cubeDomain: "cube.app",
    dbPath: ":memory:",
    stripCubeMetadata: true,
    ...overrides,
  };
  const store = new ShimStore(config.dbPath);
  const cube = new CubeClient(config.cubeApiUrl, config.cubeApiKey);
  const server = createShimServer({ config, store, cube });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    config,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          store.close();
          resolve();
        });
      }),
  };
}
