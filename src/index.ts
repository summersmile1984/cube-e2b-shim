/**
 * Cube E2B shim entrypoint.
 *
 * E2B-compatible façade over a self-hosted CubeSandbox deployment.
 */

import { promises as fs } from "node:fs";
import { loadConfig } from "./config.js";
import { ShimStore } from "./store.js";
import { CubeClient } from "./cube-client.js";
import { createShimServer } from "./server.js";

const config = loadConfig();
const store = new ShimStore(config.dbPath);
const cube = new CubeClient(config.cubeApiUrl, config.cubeApiKey);

const tls =
  config.tlsKey && config.tlsCert
    ? {
        key: await fs.readFile(config.tlsKey),
        cert: await fs.readFile(config.tlsCert),
      }
    : undefined;
const server = createShimServer({ config, store, cube, tls });

server.listen(config.listenPort, () => {
  console.log(
    JSON.stringify({
      msg: "e2b-shim listening",
      port: config.listenPort,
      protocol: tls ? "https" : "http",
      cube_api: config.cubeApiUrl,
      shim_domain: config.shimDomain || "(edge surface disabled)",
    })
  );
});

function shutdown(signal: string): void {
  console.log(JSON.stringify({ msg: "shutting down", signal }));
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
