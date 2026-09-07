/**
 * E2B-facing API surface: request routing plus the per-route semantic
 * alignment between official E2B SaaS and CubeSandbox v0.7.0.
 *
 * Alignments implemented here:
 *  - create: top-level `autoPause`/`autoResume` also map onto Cube's nested
 *    `lifecycle{onTimeout,autoResume}` object for compatibility with older
 *    Cube templates; `envVars` bypass Cube's narrower admission limits and
 *    initialize envd privately after VM startup;
 *    `secure:true` mints a shim-side envdAccessToken; the response gains
 *    startedAt/endAt (merged from Cube's GET) and the rewritten domain.
 *  - connect: E2B answers 200 when already running, 201 after a paused
 *    sandbox resumes; Cube always answers 200, so the shim tracks state.
 *  - list (v1 + v2): state/metadata filtering and cursor pagination done
 *    in memory (Cube v2 lacks metadata filtering and its nextToken is
 *    parsed but unimplemented); Cube-internal metadata keys are stripped.
 *  - fork: one Cube full-memory snapshot plus N independent snapshot restores.
 *  - lifecycle, network, snapshot, volume, log and template APIs: passthrough
 *    with E2B status, domain and metadata normalization where Cube differs.
 */

import { get as httpGet, request as httpRequest } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ShimConfig } from "./config.js";
import type { ShimStore } from "./store.js";
import type { CubeClient } from "./cube-client.js";
import { generateEnvdToken } from "./auth.js";

export interface ApiContext {
  config: ShimConfig;
  store: ShimStore;
  cube: CubeClient;
}

/** Metadata keys Cube injects that must not leak to E2B clients. */
const CUBE_INTERNAL_METADATA = /^cube\./;
const EXTRA_INTERNAL_METADATA_KEYS = new Set(["X-Caller"]);
const ENVD_PORT = 49983;
const ENVD_INIT_TIMEOUT_MS = 15_000;

export function stripInternalMetadata(
  metadata: unknown,
  enabled: boolean
): Record<string, string> | undefined {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const entries = Object.entries(metadata as Record<string, unknown>).filter(
    ([key]) =>
      !(enabled && (CUBE_INTERNAL_METADATA.test(key) || EXTRA_INTERNAL_METADATA_KEYS.has(key)))
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries.map(([k, v]) => [k, String(v)]));
}

export function normalizeSandbox(
  sandbox: Record<string, unknown>,
  config: ShimConfig
): Record<string, unknown> {
  const out = { ...sandbox };
  if (config.shimDomain) {
    out.domain = config.shimDomain;
  }
  const stripped = stripInternalMetadata(out.metadata, config.stripCubeMetadata);
  if ("metadata" in out) {
    if (stripped) out.metadata = stripped;
    else delete out.metadata;
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ShimHttpError(400, "Invalid JSON body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function sendShimError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { code: status, message });
}

/** Relay Cube's response verbatim (status + body + content-type). */
function relay(
  res: ServerResponse,
  upstream: { status: number; body: string; contentType: string; headers?: Headers }
): void {
  const headers: Record<string, string> = {
    "Content-Type": upstream.contentType || "application/json",
  };
  for (const name of ["x-next-token", "x-total-running"]) {
    const value = upstream.headers?.get(name);
    if (value) headers[name] = value;
  }
  res.writeHead(upstream.status, headers);
  res.end(upstream.body);
}

// ---------------------------------------------------------------------------
// Lifecycle handlers
// ---------------------------------------------------------------------------

interface CreateRequestBody {
  templateID?: string;
  envVars?: Record<string, string>;
  metadata?: Record<string, string>;
  timeout?: number;
  secure?: boolean;
  autoPause?: boolean;
  autoPauseMemory?: boolean;
  autoResume?: { enabled?: boolean };
  lifecycle?: { onTimeout?: string; autoResume?: boolean };
  [key: string]: unknown;
}

function parseCreateEnvVars(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ShimHttpError(400, "envVars must be an object whose values are strings");
  }

  const envVars: Record<string, string> = {};
  for (const [name, envValue] of Object.entries(value)) {
    if (!name || name.includes("=") || name.includes("\0")) {
      throw new ShimHttpError(400, `invalid environment variable name: ${JSON.stringify(name)}`);
    }
    if (typeof envValue !== "string") {
      throw new ShimHttpError(400, `environment variable ${JSON.stringify(name)} must be a string`);
    }
    if (envValue.includes("\0")) {
      throw new ShimHttpError(400, `environment variable ${JSON.stringify(name)} contains NUL`);
    }
    envVars[name] = envValue;
  }
  return envVars;
}

/**
 * Initialize envd over Cube's private proxy after the VM is ready.
 *
 * Cube 0.7 deliberately constrains `POST /sandboxes.envVars` (loader/path
 * names, 4 KiB values and a 16 KiB aggregate annotation). E2B's public
 * contract does not impose those Cube-specific restrictions. Keeping the
 * variables out of CubeAPI and posting the complete map to envd here gives
 * official SDK callers the E2B create-time environment semantics without a
 * CubeSandbox source patch. The create response is held until init succeeds,
 * so no caller can start a process against a partially initialized sandbox.
 */
async function initializeCubeEnvd(
  ctx: ApiContext,
  sandboxId: string,
  envVars: Record<string, string>
): Promise<void> {
  if (Object.keys(envVars).length === 0) return;

  const proxy = new URL(ctx.config.cubeProxyUrl);
  if (proxy.protocol !== "http:") {
    throw new Error("CUBE_PROXY_URL must use http for private envd initialization");
  }
  const payload = Buffer.from(JSON.stringify({ envVars }), "utf8");

  await new Promise<void>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: proxy.hostname,
        port: proxy.port || 80,
        method: "POST",
        path: "/init",
        headers: {
          Host: `${ENVD_PORT}-${sandboxId}.${ctx.config.cubeDomain}`,
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
        timeout: ENVD_INIT_TIMEOUT_MS,
      },
      (response) => {
        response.resume();
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`envd init returned HTTP ${status}`));
        });
      }
    );
    request.on("timeout", () => request.destroy(new Error("envd init timed out")));
    request.on("error", reject);
    request.end(payload);
  });
}

async function cleanupFailedCreate(ctx: ApiContext, sandboxId: string): Promise<void> {
  try {
    await ctx.cube.request("DELETE", `/sandboxes/${sandboxId}`);
  } catch {
    // The public error must stay deterministic and must not risk echoing
    // create-time secret values. The orphan is still bounded by its TTL.
  }
}

// ---------------------------------------------------------------------------
// Template alias resolution (E2B accepts an alias wherever a templateID goes)
// ---------------------------------------------------------------------------

interface CubeTemplate {
  templateID: string;
  aliases?: string[];
}

const aliasCache = new Map<string, { templateId: string; expiresAtMs: number }>();
const ALIAS_CACHE_TTL_MS = 60_000;

/** Test hook: drop all cached alias resolutions. */
export function clearAliasCache(): void {
  aliasCache.clear();
}

async function resolveTemplateRef(ctx: ApiContext, ref: string): Promise<string> {
  if (ref.startsWith("tpl-")) return ref;
  const cached = aliasCache.get(ref);
  if (cached && cached.expiresAtMs > Date.now()) return cached.templateId;

  const { data } = await ctx.cube.requestJson<CubeTemplate[]>("GET", "/templates");
  for (const tpl of data) {
    for (const alias of tpl.aliases ?? []) {
      aliasCache.set(alias, {
        templateId: tpl.templateID,
        expiresAtMs: Date.now() + ALIAS_CACHE_TTL_MS,
      });
    }
  }
  const resolved = aliasCache.get(ref);
  if (!resolved) {
    throw new ShimHttpError(404, `Template not found: ${ref}`);
  }
  return resolved.templateId;
}

export class ShimHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimHttpError";
  }
}

async function handleCreate(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  let body: CreateRequestBody;
  try {
    body = raw.length ? (JSON.parse(raw.toString("utf8")) as CreateRequestBody) : {};
  } catch {
    return sendShimError(res, 400, "Invalid JSON body");
  }
  if (!body.templateID) {
    return sendShimError(res, 400, "templateID is required");
  }
  const envVars = parseCreateEnvVars(body.envVars ?? body.envs);
  // Do not send E2B envVars through CubeAPI. Cube-specific admission and
  // annotation limits are implementation details of the backend, not part of
  // the E2B contract exposed by this service.
  delete body.envVars;
  delete body.envs;
  body.templateID = await resolveTemplateRef(ctx, body.templateID);

  // Map E2B's top-level convenience fields onto Cube's nested lifecycle object.
  const lifecycle: Record<string, unknown> = { ...(body.lifecycle ?? {}) };
  if (body.autoPause === true && lifecycle.onTimeout === undefined) {
    lifecycle.onTimeout = "pause";
  }
  if (
    body.autoResume &&
    typeof body.autoResume === "object" &&
    lifecycle.autoResume === undefined
  ) {
    lifecycle.autoResume = body.autoResume.enabled === true;
  }
  if (lifecycle.onTimeout === "pause" && body.autoPauseMemory === false) {
    return sendShimError(
      res,
      501,
      "filesystem-only auto-pause (autoPauseMemory=false) is not supported by Cube yet"
    );
  }
  delete body.autoPause;
  delete body.autoResume;
  if (Object.keys(lifecycle).length > 0)
    body.lifecycle = lifecycle as CreateRequestBody["lifecycle"];

  const upstream = await ctx.cube.request("POST", "/sandboxes", body);
  if (upstream.status >= 400) return relay(res, upstream);

  const created = JSON.parse(upstream.body) as Record<string, unknown>;
  const sandboxId = String(created.sandboxID);

  if (envVars) {
    try {
      await initializeCubeEnvd(ctx, sandboxId, envVars);
    } catch {
      await cleanupFailedCreate(ctx, sandboxId);
      return sendShimError(res, 502, "Sandbox environment initialization failed");
    }
  }

  let envdToken: string | null = null;
  if (body.secure === true) {
    envdToken = generateEnvdToken();
    created.envdAccessToken = envdToken;
  }

  // E2B's create response omits startedAt/endAt; Cube's does too, but its GET
  // has them. Merge best-effort so TTL-aware callers can schedule immediately.
  try {
    const detail = await ctx.cube.requestJson<Record<string, unknown>>(
      "GET",
      `/sandboxes/${sandboxId}`
    );
    if (detail.data.startedAt) created.startedAt = detail.data.startedAt;
    if (detail.data.endAt) created.endAt = detail.data.endAt;
  } catch {
    // Detail merge is best-effort; the create itself already succeeded.
  }

  ctx.store.recordSandbox({
    sandboxId,
    templateId: String(created.templateID ?? body.templateID),
    createdAtMs: Date.now(),
    timeoutSeconds: typeof body.timeout === "number" ? body.timeout : null,
    autoPause: lifecycle.onTimeout === "pause",
    lastKnownState: "running",
    envdToken,
  });

  sendJson(res, upstream.status, normalizeSandbox(created, ctx.config));
}

async function handleGet(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const upstream = await ctx.cube.request("GET", `/sandboxes/${id}`);
  if (upstream.status >= 400) return relay(res, upstream);
  const detail = JSON.parse(upstream.body) as Record<string, unknown>;
  const row = ctx.store.getSandbox(id);
  if (row?.envdToken) detail.envdAccessToken = row.envdToken;
  if (row) ctx.store.setState(id, String(detail.state ?? row.lastKnownState));
  sendJson(res, upstream.status, normalizeSandbox(detail, ctx.config));
}

async function handleKill(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const upstream = await ctx.cube.request("DELETE", `/sandboxes/${id}`);
  if (upstream.status < 400 || upstream.status === 404) {
    ctx.store.removeSandbox(id);
  }
  relay(res, upstream);
}

async function handlePause(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const body = await readJsonBody(req);
  if (typeof body === "object" && body !== null && "memory" in body && body.memory === false) {
    return sendShimError(
      res,
      501,
      "filesystem-only pause (memory=false) is not supported by Cube yet"
    );
  }
  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/pause`, body);
  if (upstream.status < 400) ctx.store.setState(id, "paused");
  relay(res, upstream);
}

async function handleResume(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const body = await readJsonBody(req);
  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/resume`, body);
  if (upstream.status >= 400) return relay(res, upstream);

  ctx.store.setState(id, "running");
  const resumed = upstream.body ? (JSON.parse(upstream.body) as Record<string, unknown>) : {};
  const row = ctx.store.getSandbox(id);
  if (row?.envdToken) resumed.envdAccessToken = row.envdToken;
  sendJson(res, 201, normalizeSandbox(resumed, ctx.config));
}

async function handleConnect(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const body = await readJsonBody(req);

  // E2B status semantics: 200 when already running, 201 when this call
  // resumed a paused sandbox. Cube returns 200 for both, so consult the
  // store first and fall back to Cube's advertised state.
  let wasPaused = ctx.store.getSandbox(id)?.lastKnownState === "paused";
  if (!wasPaused) {
    try {
      const detail = await ctx.cube.requestJson<{ state?: string }>("GET", `/sandboxes/${id}`);
      wasPaused = detail.data.state === "paused";
    } catch {
      // Unknown state: relay Cube's status code unchanged.
    }
  }

  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/connect`, body);
  if (upstream.status >= 400) return relay(res, upstream);

  ctx.store.setState(id, "running");
  const connected = upstream.body ? (JSON.parse(upstream.body) as Record<string, unknown>) : {};
  const row = ctx.store.getSandbox(id);
  if (row?.envdToken) connected.envdAccessToken = row.envdToken;
  sendJson(res, wasPaused ? 201 : 200, normalizeSandbox(connected, ctx.config));
}

async function handleSetTimeout(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const body = await readJsonBody(req);
  const upstream = await ctx.cube.request("POST", `/sandboxes/${id}/timeout`, body);
  relay(res, upstream);
}

async function handleJsonPassthrough(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  method: "POST" | "PATCH" | "PUT",
  path: string
): Promise<void> {
  const body = await readJsonBody(req);
  relay(res, await ctx.cube.request(method, path, body));
}

interface ForkRequestBody {
  timeout?: number;
  count?: number;
}

function e2bErrorFromCube(upstream: { status: number; body: string }): {
  code: number;
  message: string;
} {
  try {
    const parsed = JSON.parse(upstream.body) as { code?: unknown; message?: unknown };
    return {
      code: typeof parsed.code === "number" ? parsed.code : upstream.status,
      message:
        typeof parsed.message === "string"
          ? parsed.message
          : `Cube returned HTTP ${upstream.status}`,
    };
  } catch {
    return { code: upstream.status, message: `Cube returned HTTP ${upstream.status}` };
  }
}

/**
 * Emulate E2B's fork endpoint with Cube's native full-memory snapshot plus
 * snapshot restore. The source sandbox keeps its identity and resumes after
 * Cube captures the snapshot; every requested fork is reported independently.
 */
async function handleFork(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  id: string
): Promise<void> {
  const rawBody = await readJsonBody(req);
  if (rawBody !== undefined && (typeof rawBody !== "object" || rawBody === null)) {
    return sendShimError(res, 400, "fork body must be an object");
  }
  const body = (rawBody ?? {}) as ForkRequestBody;
  const count = body.count ?? 1;
  const timeout = body.timeout ?? 15;
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return sendShimError(res, 400, "count must be an integer between 1 and 100");
  }
  if (!Number.isInteger(timeout) || timeout < 0) {
    return sendShimError(res, 400, "timeout must be a non-negative integer");
  }

  const snapshot = await ctx.cube.request("POST", `/sandboxes/${id}/snapshots`, {});
  if (snapshot.status >= 400) return relay(res, snapshot);

  const snapshotBody = JSON.parse(snapshot.body) as { snapshotID?: unknown };
  if (typeof snapshotBody.snapshotID !== "string" || !snapshotBody.snapshotID) {
    return sendShimError(res, 502, "Cube snapshot response did not contain snapshotID");
  }

  const source = ctx.store.getSandbox(id);
  let results: Array<
    { sandbox: Record<string, unknown> } | { error: { code: number; message: string } }
  >;
  try {
    results = await Promise.all(
      Array.from({ length: count }, async () => {
        try {
          const upstream = await ctx.cube.request("POST", "/sandboxes", {
            templateID: snapshotBody.snapshotID,
            timeout,
            secure: source?.envdToken != null,
          });
          if (upstream.status >= 400) return { error: e2bErrorFromCube(upstream) };

          const sandbox = JSON.parse(upstream.body) as Record<string, unknown>;
          const sandboxId = String(sandbox.sandboxID ?? "");
          if (!sandboxId) throw new Error("missing sandboxID");
          const envdToken = source?.envdToken ? generateEnvdToken() : null;
          if (envdToken) sandbox.envdAccessToken = envdToken;
          ctx.store.recordSandbox({
            sandboxId,
            templateId: String(sandbox.templateID ?? snapshotBody.snapshotID),
            createdAtMs: Date.now(),
            timeoutSeconds: timeout,
            autoPause: false,
            lastKnownState: "running",
            envdToken,
          });
          return { sandbox: normalizeSandbox(sandbox, ctx.config) };
        } catch {
          return { error: { code: 502, message: "Cube fork creation failed" } };
        }
      })
    );
  } finally {
    // Cube persists user-created snapshots as templates. E2B's fork checkpoint
    // is internal to the operation, so remove the temporary artifact after all
    // restored sandboxes are ready. Failure here must not invalidate live forks.
    try {
      await ctx.cube.request("DELETE", `/templates/${encodeURIComponent(snapshotBody.snapshotID)}`);
    } catch {
      // Best effort: an operator can sweep a leaked temporary snapshot later.
    }
  }

  sendJson(res, 201, results);
}

// ---------------------------------------------------------------------------
// List (v1 deprecated + v2) with in-memory filtering and pagination
// ---------------------------------------------------------------------------

interface ListedSandbox {
  sandboxID: string;
  templateID?: string;
  alias?: string;
  startedAt?: string;
  state?: string;
  metadata?: Record<string, string>;
  [key: string]: unknown;
}

/** E2B v2 metadata query: a single `metadata` param holding an embedded URL-encoded `k=v&k2=v2` string. */
function parseMetadataFilter(raw: string | null): Record<string, string> {
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const pair of raw.split("&")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1));
  }
  return out;
}

function encodeCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function decodeCursor(token: string | null): number {
  if (!token) return 0;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const match = /^offset:(\d+)$/.exec(decoded);
    return match ? Number.parseInt(match[1], 10) : 0;
  } catch {
    return 0;
  }
}

async function fetchAllSandboxes(ctx: ApiContext): Promise<ListedSandbox[]> {
  // Cube 0.7 applies `limit` to its host page before collecting sandboxes, and
  // does not implement E2B's nextToken. Request the complete host inventory so
  // the shim can apply sandbox-level filtering and pagination without silently
  // losing sandboxes that live after Cube's default 100-host page.
  const upstream = await ctx.cube.requestJson<ListedSandbox[]>(
    "GET",
    "/v2/sandboxes?limit=2147483647"
  );
  return upstream.data;
}

async function handleList(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  v2: boolean
): Promise<void> {
  let all: ListedSandbox[];
  try {
    all = await fetchAllSandboxes(ctx);
  } catch (error) {
    return sendShimError(res, 502, error instanceof Error ? error.message : "upstream list failed");
  }

  const requestedStates = (url.searchParams.get("state") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // The deprecated v1 endpoint is defined as "list running sandboxes" and
  // accepts metadata only. State selection belongs to /v2/sandboxes.
  const stateFilter = v2 ? requestedStates : ["running"];
  const metadataFilter = parseMetadataFilter(url.searchParams.get("metadata"));

  let filtered = all.map((s) => normalizeSandbox(s, ctx.config) as ListedSandbox);
  if (stateFilter.length > 0) {
    filtered = filtered.filter(
      (s) => s.state !== undefined && stateFilter.includes(String(s.state))
    );
  }
  const metadataEntries = Object.entries(metadataFilter);
  if (metadataEntries.length > 0) {
    filtered = filtered.filter((s) => {
      const metadata: Record<string, string> = s.metadata ?? {};
      return metadataEntries.every(([k, v]) => metadata[k] === v);
    });
  }

  if (v2) {
    const template = url.searchParams.get("template");
    if (template) {
      filtered = filtered.filter((s) => s.templateID === template || s.alias === template);
    }

    const startedAfter = url.searchParams.get("startedAfter");
    if (startedAfter) {
      const thresholdMs = Date.parse(startedAfter);
      if (!Number.isFinite(thresholdMs)) {
        return sendShimError(res, 400, "startedAfter must be an RFC 3339 timestamp");
      }
      filtered = filtered.filter((s) => {
        const startedMs = s.startedAt ? Date.parse(s.startedAt) : Number.NaN;
        return Number.isFinite(startedMs) && startedMs >= thresholdMs;
      });
    }

    const order = url.searchParams.get("order") ?? "desc";
    if (order !== "asc" && order !== "desc") {
      return sendShimError(res, 400, "order must be asc or desc");
    }
    const direction = order === "asc" ? 1 : -1;
    filtered.sort((a, b) => {
      const aMs = a.startedAt ? Date.parse(a.startedAt) : 0;
      const bMs = b.startedAt ? Date.parse(b.startedAt) : 0;
      return (aMs - bMs) * direction;
    });
  }

  if (!v2) {
    // v1 (deprecated): bare array, no pagination.
    return sendJson(res, 200, filtered);
  }

  const limitParam = url.searchParams.get("limit");
  const limit = Math.min(Math.max(Number.parseInt(limitParam ?? "100", 10) || 100, 1), 100);
  const offset = decodeCursor(url.searchParams.get("nextToken"));
  const page = filtered.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const totalRunning = filtered.filter((s) => s.state === "running").length;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (nextOffset < filtered.length) headers["X-Next-Token"] = encodeCursor(nextOffset);
  if (stateFilter.includes("running")) headers["X-Total-Running"] = String(totalRunning);
  res.writeHead(200, headers);
  res.end(JSON.stringify(page));
}

// ---------------------------------------------------------------------------
// Metrics: Cube has no control-plane metrics endpoint; pull envd /metrics.
// ---------------------------------------------------------------------------

/**
 * Convert envd's single-point metrics JSON
 * ({ts, cpu_count, cpu_used_pct, mem_used, mem_total, mem_cache, disk_used, disk_total})
 * into E2B's SandboxMetric[] ({timestampUnix, cpuCount, cpuUsedPct, memUsed,
 * memTotal, memCache, diskUsed, diskTotal}; bytes). Unknown shapes degrade to
 * an empty series rather than an error so SDK polling never hard-fails.
 */
export function transformEnvdMetrics(payload: string): unknown[] {
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    if (Array.isArray(parsed)) return parsed;
    if (typeof parsed !== "object" || parsed === null) return [];
    if (typeof parsed.ts !== "number") return [];
    return [
      {
        timestamp: new Date(parsed.ts * 1000).toISOString(),
        timestampUnix: parsed.ts,
        cpuCount: parsed.cpu_count ?? 0,
        cpuUsedPct: parsed.cpu_used_pct ?? 0,
        memUsed: parsed.mem_used ?? 0,
        memTotal: parsed.mem_total ?? 0,
        memCache: parsed.mem_cache ?? 0,
        diskUsed: parsed.disk_used ?? 0,
        diskTotal: parsed.disk_total ?? 0,
      },
    ];
  } catch {
    return [];
  }
}

/** Latest-metric fan-in for `GET /sandboxes/metrics?sandbox_ids=a,b,c`. */
async function handleBatchMetrics(ctx: ApiContext, res: ServerResponse, url: URL): Promise<void> {
  const ids = (url.searchParams.get("sandbox_ids") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 100);
  if (ids.length === 0) {
    return sendShimError(res, 400, "sandbox_ids query parameter is required");
  }
  const out: Record<string, unknown> = {};
  await Promise.all(
    ids.map(async (id) => {
      const series = await fetchMetricsSeries(ctx, id);
      if (series.length > 0) out[id] = series[series.length - 1];
    })
  );
  sendJson(res, 200, { sandboxes: out });
}

async function fetchMetricsSeries(ctx: ApiContext, id: string): Promise<unknown[]> {
  // node:http (not fetch): undici refuses to send a custom Host header, and
  // cube-proxy routes purely on Host.
  const proxyBase = new URL(ctx.config.cubeProxyUrl);
  return new Promise((resolve) => {
    const req = httpGet(
      {
        hostname: proxyBase.hostname,
        port: proxyBase.port || 80,
        path: "/metrics",
        headers: { Host: `49983-${id}.${ctx.config.cubeDomain}` },
        timeout: 10_000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c as Buffer));
        res.on("end", () => {
          if ((res.statusCode ?? 500) >= 400) return resolve([]);
          resolve(transformEnvdMetrics(Buffer.concat(chunks).toString("utf8")));
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
    req.on("error", () => resolve([]));
  });
}

async function handleMetrics(ctx: ApiContext, res: ServerResponse, id: string): Promise<void> {
  const series = await fetchMetricsSeries(ctx, id);
  if (series.length === 0) {
    res.writeHead(200, { "Content-Type": "application/json", "X-Shim-Degraded": "metrics" });
    res.end("[]");
    return;
  }
  sendJson(res, 200, series);
}

// ---------------------------------------------------------------------------
// Template v3 build API: E2B two-step (POST /v3/templates, then
// POST /v2/templates/{id}/builds/{buildID}) collapses onto Cube's from-image
// POST /templates in one round-trip. The build worker would otherwise need
// its own Docker build context upload + step runner; Cube treats the OCI image
// as the canonical artifact.
// ---------------------------------------------------------------------------

function e2bStatusFromCubeStatus(status: string | undefined): string {
  switch (status) {
    case "READY":
      return "ready";
    case "BUILDING":
      return "building";
    case "WAITING":
      return "waiting";
    case "ERROR":
    case "FAILED":
      return "error";
    default:
      return "waiting";
  }
}

interface TemplateV3Request {
  name?: string;
  tags?: string[];
  alias?: string;
  cpuCount?: number;
  memoryMB?: number;
}

async function handleTemplateV3Create(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const raw = await readBody(req);
  let body: TemplateV3Request;
  try {
    body = raw.length ? (JSON.parse(raw.toString("utf8")) as TemplateV3Request) : {};
  } catch {
    return sendShimError(res, 400, "Invalid JSON body");
  }
  if (!body.name) return sendShimError(res, 400, "name is required");

  // Cube expects `image` (an OCI image reference). E2B's v3 `name` slot is the
  // catalog name; when the SDK uses fromImage-style builds the image already
  // exists, so pass it through. Shim-level Dockerfile-driven builds would need
  // a local docker build + localhost:5000 push (out of scope for v1).
  const upstream = await ctx.cube.request("POST", "/templates", {
    image: body.name,
    aliases: body.alias ? [body.alias] : [],
    cpu: body.cpuCount,
    memory: body.memoryMB,
    writableLayerSize: "2G",
  });
  if (upstream.status >= 400) return relay(res, upstream);
  const created = JSON.parse(upstream.body) as Record<string, unknown>;
  const templateID = String(created.templateID ?? "");
  const buildID = String(created.jobID ?? templateID);

  sendJson(res, 202, {
    templateID,
    buildID,
    public: false,
    names: body.name ? [body.name] : [],
    tags: body.tags ?? [],
    aliases: body.alias ? [body.alias] : [],
    buildStatusEnum: e2bStatusFromCubeStatus(String(created.status)),
    reason: created.status === "READY" ? "" : "build queued",
    logs: [],
  });
}

async function handleTemplateBuildTrigger(res: ServerResponse, pathname: string): Promise<void> {
  // Step/ready/start cmd overrides would land here in a full v3 implementation.
  // The cube-side build was already enqueued in handleTemplateV3Create, so
  // acknowledge and let the status poll converge.
  void pathname;
  res.writeHead(202, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ message: "build already triggered by POST /v3/templates" }));
}

interface CubeTemplateDetail {
  templateID: string;
  status?: string;
  jobID?: string;
  aliases?: string[];
  createdAt?: string;
}

async function handleTemplateBuildStatus(
  ctx: ApiContext,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  // Path shape: /templates/{templateID}/builds/{buildID}/status
  const match = /^\/templates\/([^/]+)\/builds\/([^/]+)\/status$/.exec(pathname);
  if (!match) return sendShimError(res, 400, "Malformed template build status path");
  const [, templateID, buildID] = match;
  const upstream = await ctx.cube.request("GET", `/templates/${templateID}`);
  if (upstream.status >= 400) return relay(res, upstream);
  const detail = JSON.parse(upstream.body) as CubeTemplateDetail;
  sendJson(res, 200, {
    templateID: detail.templateID,
    buildID: detail.jobID ?? buildID,
    status: e2bStatusFromCubeStatus(detail.status),
    reason: detail.status === "READY" ? "" : "queued in cube-side builder",
    logs: [],
    logEntries: [],
    aliases: detail.aliases ?? [],
    createdAt: detail.createdAt ?? "",
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const SANDBOX_ID_RE =
  /^\/sandboxes\/([^/]+)(\/(pause|resume|fork|connect|timeout|network|refreshes|snapshots|metrics))?$/;

export async function handleApiRequest(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const { pathname } = url;
  const method = req.method ?? "GET";

  try {
    if (method === "POST" && pathname === "/sandboxes") return await handleCreate(ctx, req, res);
    if (method === "GET" && pathname === "/sandboxes")
      return await handleList(ctx, req, res, url, false);
    if (method === "GET" && pathname === "/v2/sandboxes")
      return await handleList(ctx, req, res, url, true);
    if (method === "GET" && pathname === "/sandboxes/metrics")
      return await handleBatchMetrics(ctx, res, url);

    const sandboxMatch = SANDBOX_ID_RE.exec(pathname);
    if (sandboxMatch) {
      const [, id, , action] = sandboxMatch;
      if (!action) {
        if (method === "GET") return await handleGet(ctx, res, id);
        if (method === "DELETE") return await handleKill(ctx, res, id);
      }
      if (action === "pause" && method === "POST") return await handlePause(ctx, req, res, id);
      if (action === "resume" && method === "POST") return await handleResume(ctx, req, res, id);
      if (action === "fork" && method === "POST") return await handleFork(ctx, req, res, id);
      if (action === "connect" && method === "POST") return await handleConnect(ctx, req, res, id);
      if (action === "timeout" && method === "POST")
        return await handleSetTimeout(ctx, req, res, id);
      if (action === "network" && method === "PUT")
        return await handleJsonPassthrough(ctx, req, res, "PUT", `/sandboxes/${id}/network`);
      if (action === "refreshes" && method === "POST")
        return await handleJsonPassthrough(ctx, req, res, "POST", `/sandboxes/${id}/refreshes`);
      if (action === "snapshots" && method === "POST")
        return await handleJsonPassthrough(ctx, req, res, "POST", `/sandboxes/${id}/snapshots`);
      if (action === "metrics" && method === "GET") return await handleMetrics(ctx, res, id);
    }

    // Logs, snapshots and volumes: Cube v0.7 shapes and status codes match E2B.
    if (
      method === "GET" &&
      (/^\/(v2\/)?sandboxes\/[^/]+\/logs$/.test(pathname) || pathname === "/snapshots")
    ) {
      return relay(res, await ctx.cube.request("GET", pathname + url.search));
    }
    if (
      (pathname === "/volumes" && (method === "GET" || method === "POST")) ||
      (/^\/volumes\/[^/]+$/.test(pathname) && (method === "GET" || method === "DELETE"))
    ) {
      if (method === "GET" || method === "DELETE") {
        return relay(res, await ctx.cube.request(method, pathname + url.search));
      }
      return await handleJsonPassthrough(ctx, req, res, "POST", pathname + url.search);
    }

    // Templates implemented natively by Cube v0.7.
    if (
      (method === "GET" && (pathname === "/templates" || /^\/templates\/[^/]+$/.test(pathname))) ||
      (method === "POST" && pathname === "/templates") ||
      ((method === "POST" || method === "PATCH" || method === "DELETE") &&
        /^\/templates\/[^/]+$/.test(pathname)) ||
      (method === "PUT" && /^\/templates\/[^/]+\/alias$/.test(pathname)) ||
      (method === "GET" && /^\/templates\/aliases\/[^/]+$/.test(pathname)) ||
      (method === "GET" && /^\/templates\/[^/]+\/builds\/[^/]+\/logs$/.test(pathname))
    ) {
      if (method === "GET" || method === "DELETE") {
        return relay(res, await ctx.cube.request(method, pathname + url.search));
      }
      return await handleJsonPassthrough(ctx, req, res, method, pathname + url.search);
    }
    if (method === "POST" && pathname === "/v3/templates")
      return await handleTemplateV3Create(ctx, req, res);
    if (method === "POST" && /^\/v2\/templates\/[^/]+\/builds\/[^/]+$/.test(pathname))
      return await handleTemplateBuildTrigger(res, pathname);
    if (method === "GET" && /^\/templates\/[^/]+\/builds\/[^/]+\/status$/.test(pathname))
      return await handleTemplateBuildStatus(ctx, res, pathname);

    sendShimError(res, 404, `Not found: ${method} ${pathname}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status =
      error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? (error.status as number)
        : 502;
    sendShimError(res, status, message);
  }
}
