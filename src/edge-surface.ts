/**
 * Edge surface: serves sandbox data-plane traffic addressed by
 * `<port>-<sandboxID>.<shimDomain>` (or the stable `sandbox.<shimDomain>` +
 * `E2b-Sandbox-Id`/`E2b-Sandbox-Port` header entry) and proxies it to
 * cube-proxy with the Host rewritten onto Cube's internal domain.
 *
 * envd tokens are enforced twice. The shim writes each envdAccessToken into
 * envd through its private `/init` call, so envd itself checks
 * `X-Access-Token` and presigned-URL `signature`/`signature_expiration`
 * pairs, as in E2B; the header is therefore forwarded untouched. The edge
 * applies the same check first, so unknown sandboxes and bad tokens are
 * refused before any traffic reaches cube-proxy.
 *
 * Non-envd ports pass through without shim auth: cube-proxy already enforces
 * E2B's `e2b-traffic-access-token` for sandboxes created with
 * `allowPublicTraffic=false`, and public preview ports stay public otherwise.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import http from "node:http";
import net from "node:net";
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { ShimConfig } from "./config.js";
import type { ShimStore } from "./store.js";
import { fileSignature } from "./auth.js";

export interface EdgeContext {
  config: ShimConfig;
  store: ShimStore;
}

export interface EdgeTarget {
  port: number;
  sandboxId: string;
}

const ENVD_PORT = 49983;

/**
 * envd endpoints marked `x-internal` in the envd spec (/init can reset the
 * secure token; freeze/fsfreeze pair with host-side pause). E2B's public
 * proxy rejects them; the shim edge must too.
 */
const ENVD_INTERNAL_PATHS = new Set([
  "/init",
  "/freeze",
  "/unfreeze",
  "/fsfreeze",
  "/fsthaw",
  "/collapse",
  "/upgrade",
]);

/** Parse `<port>-<sandboxID>.<shimDomain>`; sandbox IDs contain no dashes or dots. */
export function parseEdgeHost(host: string | undefined, shimDomain: string): EdgeTarget | null {
  if (!host || !shimDomain) return null;
  const hostname = host.split(":")[0].toLowerCase();
  const domain = shimDomain.toLowerCase();

  if (hostname === `sandbox.${domain}`) return { port: -1, sandboxId: "" }; // header-based entry
  if (!hostname.endsWith(`.${domain}`)) return null;
  const prefix = hostname.slice(0, hostname.length - domain.length - 1);
  const match = /^(\d+)-([A-Za-z0-9]+)$/.exec(prefix);
  if (!match) return null;
  return { port: Number.parseInt(match[1], 10), sandboxId: match[2] };
}

/**
 * Resolve the stable E2B_SANDBOX_URL form. Official SDKs attach these headers
 * when a single gateway URL handles every sandbox and port, so the gateway may
 * share a hostname with the control-plane API and does not require wildcard DNS.
 */
export function parseEdgeHeaders(headers: IncomingHttpHeaders): EdgeTarget | null {
  const rawId = headers["e2b-sandbox-id"];
  const rawPort = headers["e2b-sandbox-port"];
  const sandboxId = Array.isArray(rawId) ? rawId[0] : rawId;
  const port = Array.isArray(rawPort) ? rawPort[0] : rawPort;
  if (
    typeof sandboxId !== "string" ||
    !/^[A-Za-z0-9]+$/.test(sandboxId) ||
    typeof port !== "string" ||
    !/^\d+$/.test(port)
  ) {
    return null;
  }
  const portNumber = Number.parseInt(port, 10);
  if (portNumber < 1 || portNumber > 65_535) return null;
  return { port: portNumber, sandboxId };
}

/** Resolve the stable `sandbox.<domain>` entry from its routing headers. */
function resolveHeaderEntry(req: IncomingMessage): EdgeTarget | null {
  return parseEdgeHeaders(req.headers);
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * envd authorization. Mirrors E2B: sandboxes created without `secure` (no
 * token recorded) accept anonymous envd traffic; sandboxes with a token
 * require it. Sandboxes the shim has never seen are denied — they did not go
 * through the shim's create path, so no token contract exists for them.
 */
export function isEnvdAuthorized(
  ctx: EdgeContext,
  req: IncomingMessage,
  url: URL,
  sandboxId: string
): boolean {
  const row = ctx.store.getSandbox(sandboxId);
  if (!row) return false;
  if (!row.envdToken) return true;

  const headerToken = req.headers["x-access-token"];
  if (typeof headerToken === "string" && safeEqual(headerToken, row.envdToken)) return true;

  // Presigned file URLs: signature over "path:op:user:token[:exp]". Standard
  // base64 `+` survives URL-decoding as a space, so normalize before compare.
  const signature = url.searchParams.get("signature")?.replace(/ /g, "+");
  if (signature) {
    const path = url.searchParams.get("path") ?? "";
    // Empty user denotes the default user in E2B's signature scheme.
    const user = url.searchParams.get("username") ?? "";
    const expRaw = url.searchParams.get("signature_expiration");
    const exp = expRaw ? Number.parseInt(expRaw, 10) : undefined;
    if (exp !== undefined && Number.isFinite(exp) && exp * 1000 < Date.now()) return false;
    const op = (req.method ?? "GET") === "GET" ? "read" : "write";
    const expected = fileSignature(
      path,
      op,
      user,
      row.envdToken,
      Number.isFinite(exp) ? exp : undefined
    );
    if (safeEqual(signature, expected)) return true;
  }
  return false;
}

/** Headers that must not be forwarded hop-by-hop. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function forwardHeaders(
  req: IncomingMessage,
  target: EdgeTarget,
  cubeDomain: string,
  trafficToken: string | null | undefined
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  // CubeProxy rejects requests to sandboxes created with
  // allowPublicTraffic=false unless the per-sandbox traffic token is present.
  // The E2B JS SDK stores the token but does not replay it on envd calls, so
  // the shim injects the token it captured at create time.
  if (trafficToken && !out["e2b-traffic-access-token"] && !out["cube-traffic-access-token"]) {
    out["e2b-traffic-access-token"] = trafficToken;
  }
  out["Host"] = `${target.port}-${target.sandboxId}.${cubeDomain}`;
  return out;
}

function sendEdgeError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ code: status, message }));
}

export function handleEdgeRequest(
  ctx: EdgeContext,
  req: IncomingMessage,
  res: ServerResponse,
  target: EdgeTarget
): void {
  const resolved = target.port === -1 ? resolveHeaderEntry(req) : target;
  if (!resolved) return sendEdgeError(res, 400, "Missing E2b-Sandbox-Id/E2b-Sandbox-Port headers");

  const url = new URL(req.url ?? "/", "http://edge.invalid");
  const row = ctx.store.getSandbox(resolved.sandboxId);
  if (resolved.port === ENVD_PORT) {
    if (ENVD_INTERNAL_PATHS.has(url.pathname)) {
      return sendEdgeError(res, 403, "Forbidden: envd internal endpoint");
    }
    if (!isEnvdAuthorized(ctx, req, url, resolved.sandboxId)) {
      return sendEdgeError(res, 401, "Unauthorized: valid envd access token required");
    }
  }

  const proxyBase = new URL(ctx.config.cubeProxyUrl);
  const upstream = http.request(
    {
      hostname: proxyBase.hostname,
      port: proxyBase.port || 80,
      method: req.method,
      path: req.url,
      headers: forwardHeaders(req, resolved, ctx.config.cubeDomain, row?.trafficToken),
      timeout: 120_000,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers as http.OutgoingHttpHeaders);
      upstreamRes.pipe(res);
    }
  );
  upstream.on("timeout", () => {
    upstream.destroy();
    if (!res.headersSent) sendEdgeError(res, 504, "Upstream sandbox timed out");
  });
  upstream.on("error", () => {
    if (!res.headersSent) sendEdgeError(res, 502, "Sandbox unreachable");
    else res.destroy();
  });
  req.pipe(upstream);
}

/**
 * WebSocket/data-plane upgrade passthrough: open a raw TCP socket to
 * cube-proxy, replay the request with the rewritten Host, then pipe.
 */
export function handleEdgeUpgrade(
  ctx: EdgeContext,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  target: EdgeTarget
): void {
  const resolved = target.port === -1 ? resolveHeaderEntry(req) : target;
  if (!resolved) {
    socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const url = new URL(req.url ?? "/", "http://edge.invalid");
  const row = ctx.store.getSandbox(resolved.sandboxId);
  if (resolved.port === ENVD_PORT) {
    if (ENVD_INTERNAL_PATHS.has(url.pathname)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!isEnvdAuthorized(ctx, req, url, resolved.sandboxId)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  const proxyBase = new URL(ctx.config.cubeProxyUrl);
  const upstream = net.connect(Number(proxyBase.port) || 80, proxyBase.hostname, () => {
    const headers = forwardHeaders(req, resolved, ctx.config.cubeDomain, row?.trafficToken);
    headers["Connection"] = "Upgrade";
    if (req.headers.upgrade) headers["Upgrade"] = String(req.headers.upgrade);
    let requestLine = `${req.method} ${req.url} HTTP/1.1\r\n`;
    for (const [key, value] of Object.entries(headers)) requestLine += `${key}: ${value}\r\n`;
    upstream.write(requestLine + "\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

/** Cheap integrity helper for tests: sha256 hex of the stored token row. */
export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
