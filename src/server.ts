/**
 * HTTP server: splits the API surface from the edge surface by Host header.
 *
 * A single listener serves both because the cloudflared ingress records for
 * `cubeapi.<domain>` (API) and `*.<shimDomain>` (edge) point at the same local
 * port. Hostnames that match neither surface get 404.
 */

import http from "node:http";
import https from "node:https";
import type { ShimConfig } from "./config.js";
import type { ShimStore } from "./store.js";
import type { CubeClient } from "./cube-client.js";
import { Platform } from "./platform.js";
import { EventHub, templateDescriber } from "./events.js";
import { VolumeContent } from "./volume-content.js";
import { handleApiRequest, resolveTemplateRef } from "./api-surface.js";
import { TemplateBuilder } from "./template-builder.js";
import {
  handleEdgeRequest,
  handleEdgeUpgrade,
  parseEdgeHeaders,
  parseEdgeHost,
} from "./edge-surface.js";

export interface ServerDeps {
  config: ShimConfig;
  store: ShimStore;
  cube: CubeClient;
  /** TLS material; when both key and cert are present the listener is HTTPS. */
  tls?: { key: Buffer; cert: Buffer };
  /** Template build engine; created from the config when omitted. */
  builder?: TemplateBuilder;
  /** Team identity, encryption and authentication; created when omitted. */
  platform?: Platform;
  /** Lifecycle events, metrics and webhooks; created when omitted (poller not started). */
  events?: EventHub;
  /** Volume content API; created when omitted (idle reaper not started). */
  volumes?: VolumeContent;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createShimServer(deps: ServerDeps): http.Server | https.Server {
  const { config, store, cube, tls } = deps;
  const platform = deps.platform ?? new Platform(config, store);
  const events =
    deps.events ??
    new EventHub(config, store, cube, platform, templateDescriber(store));
  const builder =
    deps.builder ??
    new TemplateBuilder(
      config,
      store,
      cube,
      { filesDir: config.buildFilesDir, writableLayerSize: config.templateDiskSize },
      (ref) => resolveTemplateRef({ store, cube }, ref)
    );

  const volumes =
    deps.volumes ??
    new VolumeContent(config, cube, platform, (ref) => resolveTemplateRef({ store, cube }, ref));

  const requestListener = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://shim.invalid");

      if (url.pathname === "/health") {
        return json(res, 200, { status: "ok" });
      }

      const edgeTarget =
        parseEdgeHost(req.headers.host, config.shimDomain) ?? parseEdgeHeaders(req.headers);
      if (edgeTarget) {
        return handleEdgeRequest({ config, store }, req, res, edgeTarget);
      }

      // Template COPY archive upload: authorized by the presigned URL the
      // SDK received from GET /templates/{id}/files/{hash}, not an API key.
      const upload = /^\/template-files\/([^/]+)$/.exec(url.pathname);
      if (upload && req.method === "PUT") {
        const hash = decodeURIComponent(upload[1]);
        if (!builder.verifyUpload(hash, url)) {
          return json(res, 403, { code: 403, message: "invalid or expired upload URL" });
        }
        await builder.receiveUpload(hash, req);
        return json(res, 200, { status: "uploaded" });
      }

      // Volume content API: authorized by the per-volume bearer token.
      if (url.pathname.startsWith("/volumecontent/") && (await volumes.handle(req, res, url))) return;

      // API surface: X-API-Key, access token or admin credentials.
      const auth = platform.authenticate(req);
      if ("status" in auth) return json(res, auth.status, { code: auth.status, message: auth.message });

      await handleApiRequest(
        { config, store, cube, builder, platform, events, volumes, principal: auth.principal },
        req,
        res,
        url
      );
    })().catch((error) => {
      if (!res.headersSent) {
        json(res, 500, {
          code: 500,
          message: error instanceof Error ? error.message : "internal shim error",
        });
      } else {
        res.destroy();
      }
    });
  };

  const server = tls
    ? https.createServer(tls, requestListener)
    : http.createServer(requestListener);

  server.on("upgrade", (req, socket, head) => {
    const edgeTarget =
      parseEdgeHost(req.headers.host, config.shimDomain) ?? parseEdgeHeaders(req.headers);
    if (!edgeTarget) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    handleEdgeUpgrade({ config, store }, req, socket, head, edgeTarget);
  });

  return server;
}
