/**
 * E2B platform APIs beyond sandboxes and templates: teams, API keys, secrets,
 * sandbox events, team metrics, webhooks and the admin surface. Each route
 * declares the principals E2B's OpenAPI security schemes allow for it.
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiContext } from "./api-surface.js";
import { SANDBOX_EVENT_TYPES, isInternalSandbox } from "./events.js";
import {
  ShimHttpError,
  intParam,
  listParam,
  readObjectBody,
  sendEmpty,
  sendJson,
  sendShimError,
} from "./http-util.js";
import type { PrincipalKind } from "./platform.js";
import { SECRET_NAME_RE, validateSecretMetadata } from "./secrets.js";
import type { SecretRow, WebhookDeliveryRow, WebhookRow } from "./store.js";

type Handler = (
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  params: string[],
  url: URL
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  allow: PrincipalKind[];
  handler: Handler;
}

const ANY: PrincipalKind[] = ["apiKey", "accessToken", "admin"];
const ACCOUNT: PrincipalKind[] = ["accessToken", "admin"];
const ADMIN: PrincipalKind[] = ["admin"];

const routes: Route[] = [];

/** Register a route. Exported so feature modules can add their own. */
export function route(method: string, pattern: RegExp, allow: PrincipalKind[], handler: Handler): void {
  routes.push({ method, pattern, allow, handler });
}

export { ANY, ACCOUNT, ADMIN };

/** Returns true when a management route handled the request. */
export async function handleManagementRequest(
  ctx: ApiContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const method = req.method ?? "GET";
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    const match = candidate.pattern.exec(url.pathname);
    if (!match) continue;
    if (!candidate.allow.includes(ctx.principal.kind)) {
      sendShimError(
        res,
        candidate.allow.every((kind) => kind === "admin") ? 403 : 401,
        candidate.allow.includes("accessToken")
          ? "This endpoint requires an access token (Authorization: Bearer) or admin credentials"
          : "This endpoint requires admin credentials"
      );
      return true;
    }
    await candidate.handler(
      ctx,
      req,
      res,
      match.slice(1).map((value) => decodeURIComponent(value)),
      url
    );
    return true;
  }
  return false;
}

/** E2B scopes team resources by ID; only this deployment's team exists. */
export function requireTeam(ctx: ApiContext, teamId: string): void {
  if (teamId !== ctx.platform.teamId) throw new ShimHttpError(404, `Team ${teamId} not found`);
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

route("GET", /^\/teams$/, ACCOUNT, async (ctx, _req, res) => {
  sendJson(res, 200, [
    {
      teamID: ctx.platform.teamId,
      name: ctx.platform.teamName,
      apiKey: ctx.config.apiKeys[0] ?? "",
      isDefault: true,
    },
  ]);
});

// ---------------------------------------------------------------------------
// API keys
// ---------------------------------------------------------------------------

function keyName(body: Record<string, unknown>): string {
  const name = body.name;
  if (typeof name !== "string" || !name.trim()) throw new ShimHttpError(400, "name is required");
  return name.trim();
}

function createdKeyResponse(created: ReturnType<ApiContext["platform"]["mintApiKey"]>, name: string) {
  return {
    id: created.id,
    key: created.key,
    mask: created.mask,
    name,
    createdAt: created.createdAt,
    createdBy: null,
    lastUsed: null,
  };
}

route("GET", /^\/api-keys$/, ACCOUNT, async (ctx, _req, res) => {
  sendJson(
    res,
    200,
    ctx.store.listApiKeys().map((key) => ({ ...key, createdBy: null }))
  );
});

route("POST", /^\/api-keys$/, ["accessToken"], async (ctx, req, res) => {
  const name = keyName(await readObjectBody(req));
  sendJson(res, 201, createdKeyResponse(ctx.platform.mintApiKey(name), name));
});

route("PATCH", /^\/api-keys\/([^/]+)$/, ACCOUNT, async (ctx, req, res, [id]) => {
  const name = keyName(await readObjectBody(req));
  if (!ctx.store.renameApiKey(id, name)) throw new ShimHttpError(404, `API key ${id} not found`);
  sendEmpty(res, 200);
});

route("DELETE", /^\/api-keys\/([^/]+)$/, ACCOUNT, async (ctx, _req, res, [id]) => {
  if (!ctx.store.deleteApiKey(id)) throw new ShimHttpError(404, `API key ${id} not found`);
  sendEmpty(res, 204);
});

route("POST", /^\/admin\/teams\/([^/]+)\/api-keys$/, ADMIN, async (ctx, req, res, [teamId]) => {
  requireTeam(ctx, teamId);
  const name = keyName(await readObjectBody(req));
  sendJson(res, 201, createdKeyResponse(ctx.platform.mintApiKey(name), name));
});

route(
  "DELETE",
  /^\/admin\/teams\/([^/]+)\/api-keys\/([^/]+)$/,
  ADMIN,
  async (ctx, _req, res, [teamId, id]) => {
    requireTeam(ctx, teamId);
    if (!ctx.store.deleteApiKey(id)) throw new ShimHttpError(404, `API key ${id} not found`);
    sendEmpty(res, 204);
  }
);

// ---------------------------------------------------------------------------
// Sandbox events
// ---------------------------------------------------------------------------

function eventQuery(url: URL) {
  const types = listParam(url, "types");
  for (const type of types) {
    if (!(SANDBOX_EVENT_TYPES as readonly string[]).includes(type)) {
      throw new ShimHttpError(400, `unknown event type ${JSON.stringify(type)}`);
    }
  }
  return {
    offset: intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: intParam(url, "limit", 10, 1, 100),
    orderAsc: url.searchParams.get("orderAsc") === "true",
    types,
  };
}

route("GET", /^\/events\/sandboxes$/, ANY, async (ctx, _req, res, _params, url) => {
  sendJson(res, 200, ctx.store.listEvents(eventQuery(url)).map((event) => ctx.events.toApi(event)));
});

route("GET", /^\/events\/sandboxes\/([^/]+)$/, ANY, async (ctx, _req, res, [sandboxId], url) => {
  if (!ctx.store.hasEvents(sandboxId) && !ctx.store.getObserved(sandboxId)) {
    throw new ShimHttpError(404, `Sandbox ${sandboxId} not found`);
  }
  sendJson(
    res,
    200,
    ctx.store.listEvents({ ...eventQuery(url), sandboxId }).map((event) => ctx.events.toApi(event))
  );
});

// ---------------------------------------------------------------------------
// Team metrics (sampled by the event poller)
// ---------------------------------------------------------------------------

function metricRange(url: URL): { start: number; end: number } {
  const now = Math.floor(Date.now() / 1000);
  const end = intParam(url, "end", now, 0, Number.MAX_SAFE_INTEGER);
  const start = intParam(url, "start", end - 60 * 60, 0, Number.MAX_SAFE_INTEGER);
  if (start > end) throw new ShimHttpError(400, "start must not be after end");
  return { start, end };
}

route("GET", /^\/teams\/([^/]+)\/metrics$/, ANY, async (ctx, _req, res, [teamId], url) => {
  requireTeam(ctx, teamId);
  const { start, end } = metricRange(url);
  sendJson(
    res,
    200,
    ctx.store.listTeamMetrics(start, end).map((metric) => ({
      timestamp: new Date(metric.timestampUnix * 1000).toISOString(),
      timestampUnix: metric.timestampUnix,
      concurrentSandboxes: metric.concurrent,
      sandboxStartRate: metric.started / metric.intervalSeconds,
    }))
  );
});

route("GET", /^\/teams\/([^/]+)\/metrics\/max$/, ANY, async (ctx, _req, res, [teamId], url) => {
  requireTeam(ctx, teamId);
  const metric = url.searchParams.get("metric");
  if (metric !== "concurrent_sandboxes" && metric !== "sandbox_start_rate") {
    throw new ShimHttpError(400, "metric must be concurrent_sandboxes or sandbox_start_rate");
  }
  const { start, end } = metricRange(url);
  let best = { timestampUnix: end, value: 0 };
  for (const row of ctx.store.listTeamMetrics(start, end)) {
    const value = metric === "concurrent_sandboxes" ? row.concurrent : row.started / row.intervalSeconds;
    if (value > best.value) best = { timestampUnix: row.timestampUnix, value };
  }
  sendJson(res, 200, {
    timestamp: new Date(best.timestampUnix * 1000).toISOString(),
    timestampUnix: best.timestampUnix,
    value: best.value,
  });
});

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

function webhookDetail(ctx: ApiContext, hook: WebhookRow) {
  return {
    id: hook.id,
    teamId: ctx.platform.teamId,
    name: hook.name,
    createdAt: hook.createdAt,
    url: hook.url,
    enabled: hook.enabled,
    events: hook.events,
  };
}

function validateWebhookFields(body: Record<string, unknown>, partial: boolean): void {
  const need = (key: string) => !partial || key in body;
  if (need("name") && (typeof body.name !== "string" || !body.name.trim())) {
    throw new ShimHttpError(400, "name is required");
  }
  if (need("url")) {
    let parsed: URL | null = null;
    try {
      parsed = typeof body.url === "string" ? new URL(body.url) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
      throw new ShimHttpError(400, "url must be an http(s) URL");
    }
  }
  if (need("events")) {
    if (!Array.isArray(body.events) || body.events.length === 0) {
      throw new ShimHttpError(400, "events must list at least one event type");
    }
    for (const type of body.events) {
      if (!(SANDBOX_EVENT_TYPES as readonly unknown[]).includes(type)) {
        throw new ShimHttpError(400, `unknown event type ${JSON.stringify(type)}`);
      }
    }
  }
  if (need("signatureSecret") && (typeof body.signatureSecret !== "string" || !body.signatureSecret)) {
    throw new ShimHttpError(400, "signatureSecret is required");
  }
  if ("enabled" in body && typeof body.enabled !== "boolean") {
    throw new ShimHttpError(400, "enabled must be a boolean");
  }
}

function getWebhookOr404(ctx: ApiContext, id: string): WebhookRow {
  const hook = ctx.store.getWebhook(id);
  if (!hook) throw new ShimHttpError(404, `Webhook ${id} not found`);
  return hook;
}

route("POST", /^\/events\/webhooks$/, ANY, async (ctx, req, res) => {
  const body = await readObjectBody(req);
  validateWebhookFields(body, false);
  const hook: WebhookRow = {
    id: randomUUID(),
    name: String(body.name).trim(),
    url: String(body.url),
    events: body.events as string[],
    enabled: body.enabled !== false,
    secret: ctx.platform.encrypt(String(body.signatureSecret)),
    createdAt: new Date().toISOString(),
  };
  ctx.store.createWebhook(hook);
  sendJson(res, 201, webhookDetail(ctx, hook));
});

route("GET", /^\/events\/webhooks$/, ANY, async (ctx, _req, res) => {
  sendJson(res, 200, ctx.store.listWebhooks().map((hook) => webhookDetail(ctx, hook)));
});

route("GET", /^\/events\/webhooks\/([^/]+)$/, ANY, async (ctx, _req, res, [id]) => {
  sendJson(res, 200, webhookDetail(ctx, getWebhookOr404(ctx, id)));
});

route("PATCH", /^\/events\/webhooks\/([^/]+)$/, ANY, async (ctx, req, res, [id]) => {
  const hook = getWebhookOr404(ctx, id);
  const body = await readObjectBody(req);
  validateWebhookFields(body, true);
  const updated: WebhookRow = {
    ...hook,
    ...(typeof body.name === "string" ? { name: body.name.trim() } : {}),
    ...(typeof body.url === "string" ? { url: body.url } : {}),
    ...(Array.isArray(body.events) ? { events: body.events as string[] } : {}),
    ...(typeof body.enabled === "boolean" ? { enabled: body.enabled } : {}),
    ...(typeof body.signatureSecret === "string"
      ? { secret: ctx.platform.encrypt(body.signatureSecret) }
      : {}),
  };
  ctx.store.updateWebhook(updated);
  sendJson(res, 200, webhookDetail(ctx, updated));
});

route("DELETE", /^\/events\/webhooks\/([^/]+)$/, ANY, async (ctx, _req, res, [id]) => {
  if (!ctx.store.deleteWebhook(id)) throw new ShimHttpError(404, `Webhook ${id} not found`);
  sendEmpty(res, 200);
});

function isoParam(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new ShimHttpError(400, `${name} must be an RFC 3339 timestamp`);
  return new Date(ms).toISOString();
}

function deliveryApi(ctx: ApiContext, delivery: WebhookDeliveryRow) {
  return { ...delivery, teamId: ctx.platform.teamId };
}

route("GET", /^\/events\/webhooks\/([^/]+)\/deliveries$/, ANY, async (ctx, _req, res, [id], url) => {
  getWebhookOr404(ctx, id);
  const statuses = listParam(url, "deliveryStatus");
  const eventTypes = listParam(url, "eventType");
  const limit = intParam(url, "limit", 25, 1, 100);
  const orderAsc = url.searchParams.get("orderAsc") === "true";
  const offset = decodeOffsetCursor(url.searchParams.get("cursor"));

  const attempts = ctx.store
    .listDeliveries(id, { start: isoParam(url, "start"), end: isoParam(url, "end") })
    .filter((attempt) => statuses.length === 0 || statuses.includes(attempt.status))
    .filter((attempt) => eventTypes.length === 0 || eventTypes.includes(attempt.eventType));
  const groups = new Map<string, { first: string; attempts: WebhookDeliveryRow[] }>();
  for (const attempt of attempts) {
    const group = groups.get(attempt.eventId) ?? { first: attempt.timestamp, attempts: [] };
    group.attempts.push(attempt);
    groups.set(attempt.eventId, group);
  }
  const ordered = [...groups.entries()].sort(([, a], [, b]) =>
    orderAsc ? a.first.localeCompare(b.first) : b.first.localeCompare(a.first)
  );
  const page = ordered.slice(offset, offset + limit);
  sendJson(res, 200, {
    data: page.map(([eventId, group]) => ({
      eventId,
      eventType: group.attempts[0].eventType,
      sandboxId: group.attempts[0].sandboxId,
      attempts: group.attempts.map((attempt) => deliveryApi(ctx, attempt)),
    })),
    nextCursor: offset + page.length < ordered.length ? encodeOffsetCursor(offset + page.length) : null,
  });
});

function durationStats(values: number[]) {
  if (values.length === 0) return { minimum: 0, average: 0, maximum: 0 };
  return {
    minimum: Math.min(...values),
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    maximum: Math.max(...values),
  };
}

route("GET", /^\/events\/webhooks\/([^/]+)\/stats$/, ANY, async (ctx, _req, res, [id], url) => {
  getWebhookOr404(ctx, id);
  const end = isoParam(url, "end") ?? new Date().toISOString();
  const start = isoParam(url, "start") ?? new Date(Date.parse(end) - 24 * 60 * 60 * 1000).toISOString();
  const attempts = ctx.store.listDeliveries(id, { start, end });
  const hour = 60 * 60 * 1000;
  const buckets = new Map<number, WebhookDeliveryRow[]>();
  for (const attempt of attempts) {
    const bucket = Math.floor(Date.parse(attempt.timestamp) / hour) * hour;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), attempt]);
  }
  sendJson(res, 200, {
    buckets: [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([bucket, items]) => ({
        timestamp: new Date(bucket).toISOString(),
        total: items.length,
        failed: items.filter((item) => item.status === "failed").length,
        durationMs: durationStats(items.map((item) => item.durationMs)),
      })),
    total: attempts.length,
    failed: attempts.filter((item) => item.status === "failed").length,
    durationMs: durationStats(attempts.map((item) => item.durationMs)),
  });
});

function encodeOffsetCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function decodeOffsetCursor(token: string | null): number {
  if (!token) return 0;
  const match = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
  if (!match) throw new ShimHttpError(400, "invalid cursor");
  return Number.parseInt(match[1], 10);
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

function secretApi(secret: SecretRow) {
  return {
    secretID: secret.id,
    name: secret.name,
    currentVersion: secret.currentVersion,
    metadata: secret.metadata,
    createdAt: secret.createdAt,
    updatedAt: secret.updatedAt,
  };
}

function getSecretOr404(ctx: ApiContext, idOrName: string): SecretRow {
  const secret = ctx.store.getSecret(idOrName);
  if (!secret) throw new ShimHttpError(404, `Secret ${idOrName} not found`);
  return secret;
}

route("GET", /^\/secrets$/, ANY, async (ctx, _req, res, _params, url) => {
  const limit = intParam(url, "limit", 100, 1, 100);
  const offset = decodeOffsetCursor(url.searchParams.get("nextToken"));
  const page = ctx.store.listSecrets(offset, limit);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (offset + page.length < ctx.store.countSecrets()) {
    headers["X-Next-Token"] = encodeOffsetCursor(offset + page.length);
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify(page.map(secretApi)));
});

route("POST", /^\/secrets$/, ANY, async (ctx, req, res) => {
  const body = await readObjectBody(req);
  if (typeof body.name !== "string" || !SECRET_NAME_RE.test(body.name)) {
    throw new ShimHttpError(400, "name must match ^[a-zA-Z0-9_-]+$ (1-128 characters)");
  }
  const name = body.name.toLowerCase();
  if (name.startsWith("sec_")) throw new ShimHttpError(400, "the sec_ prefix is reserved for secret IDs");
  if (typeof body.value !== "string") throw new ShimHttpError(400, "value must be a string");
  const metadata = validateSecretMetadata(body.metadata);
  if (ctx.store.getSecret(name)) throw new ShimHttpError(409, `Secret ${name} already exists`);
  const now = new Date().toISOString();
  const secret: SecretRow = {
    id: `sec_${randomUUID().replace(/-/g, "")}`,
    name,
    currentVersion: 1,
    metadata,
    createdAt: now,
    updatedAt: now,
  };
  ctx.store.createSecret({ ...secret, value: ctx.platform.encrypt(body.value) });
  sendJson(res, 201, secretApi(secret));
});

route("GET", /^\/secrets\/([^/]+)$/, ANY, async (ctx, _req, res, [id]) => {
  sendJson(res, 200, secretApi(getSecretOr404(ctx, id)));
});

route("POST", /^\/secrets\/([^/]+)$/, ANY, async (ctx, req, res, [id]) => {
  const secret = getSecretOr404(ctx, id);
  const body = await readObjectBody(req);
  if (typeof body.value !== "string") throw new ShimHttpError(400, "value must be a string");
  const metadata = "metadata" in body ? validateSecretMetadata(body.metadata) : null;
  const updated = ctx.store.updateSecret(secret.id, ctx.platform.encrypt(body.value), metadata);
  sendJson(res, 200, secretApi(updated as SecretRow));
});

route("DELETE", /^\/secrets\/([^/]+)$/, ANY, async (ctx, _req, res, [id]) => {
  ctx.store.deleteSecret(getSecretOr404(ctx, id).id);
  sendEmpty(res, 204);
});

// ---------------------------------------------------------------------------
// Admin: team sandboxes and builds
// ---------------------------------------------------------------------------

interface CubeSandboxSummary {
  sandboxID: string;
  templateID?: string;
  state?: string;
  clientID?: string;
  metadata?: Record<string, string>;
}

async function listUserSandboxes(ctx: ApiContext): Promise<CubeSandboxSummary[]> {
  const { data } = await ctx.cube.requestJson<CubeSandboxSummary[]>("GET", "/v2/sandboxes?limit=2147483647");
  return data.filter((sandbox) => !isInternalSandbox(sandbox));
}

route("POST", /^\/admin\/teams\/([^/]+)\/sandboxes\/kill$/, ADMIN, async (ctx, _req, res, [teamId]) => {
  requireTeam(ctx, teamId);
  let killedCount = 0;
  let failedCount = 0;
  for (const sandbox of await listUserSandboxes(ctx)) {
    const upstream = await ctx.cube.request("DELETE", `/sandboxes/${sandbox.sandboxID}`).catch(() => null);
    if (upstream && (upstream.status < 400 || upstream.status === 404)) {
      killedCount++;
      ctx.store.removeSandbox(sandbox.sandboxID);
      ctx.events.record(
        "sandbox.lifecycle.killed",
        { sandboxId: sandbox.sandboxID, templateId: sandbox.templateID },
        { source: "admin" }
      );
    } else {
      failedCount++;
    }
  }
  sendJson(res, 200, { killedCount, failedCount });
});

route("GET", /^\/admin\/sandboxes\/running-counts$/, ADMIN, async (ctx, _req, res) => {
  const running = (await listUserSandboxes(ctx)).filter((s) => (s.state ?? "running") === "running").length;
  sendJson(res, 200, running > 0 ? { [ctx.platform.teamId]: running } : {});
});

route("POST", /^\/admin\/teams\/([^/]+)\/builds\/cancel$/, ADMIN, async (ctx, _req, res, [teamId]) => {
  requireTeam(ctx, teamId);
  sendJson(res, 200, { cancelledCount: ctx.builder.cancelAll(), failedCount: 0 });
});

// ---------------------------------------------------------------------------
// Admin: nodes (CubeOps) and rigs
// ---------------------------------------------------------------------------

interface CubeOpsNode {
  nodeID: string;
  hostIP: string;
  healthy: boolean;
  unhealthyReason?: string;
  schedulingDisabled: boolean;
  capacity: { cpuMilli: number; memoryMB: number };
  allocatable: { cpuMilli: number; memoryMB: number };
  cpuSaturation?: number;
  maxMvmSlots?: number;
  heartbeatTime?: string | null;
  versions?: Array<{ component: string; version: string; commit: string }>;
}

async function cubeOps(ctx: ApiContext, method: string, path: string): Promise<Response> {
  if (!ctx.config.cubeOpsUrl) {
    throw new ShimHttpError(501, "node administration requires CUBE_OPS_URL (and CUBE_OPS_TOKEN)");
  }
  return fetch(`${ctx.config.cubeOpsUrl}/api/v1${path}`, {
    method,
    headers: ctx.config.cubeOpsToken ? { Authorization: `Bearer ${ctx.config.cubeOpsToken}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
}

function requireCluster(ctx: ApiContext, url: URL): void {
  const clusterId = url.searchParams.get("clusterID");
  if (clusterId && clusterId !== ctx.config.clusterId) {
    throw new ShimHttpError(404, `Cluster ${clusterId} not found`);
  }
}

function nodeApi(ctx: ApiContext, node: CubeOpsNode, sandboxes: CubeSandboxSummary[]) {
  const mib = 1024 * 1024;
  const cubelet = node.versions?.find((v) => v.component.toLowerCase() === "cubelet") ?? node.versions?.[0];
  return {
    id: node.nodeID,
    serviceInstanceID: node.nodeID,
    clusterID: ctx.config.clusterId,
    status: !node.healthy ? "unhealthy" : node.schedulingDisabled ? "draining" : "ready",
    statusChangedAt: node.heartbeatTime ?? new Date().toISOString(),
    sandboxCount: sandboxes.filter((s) => s.clientID === node.hostIP && (s.state ?? "running") === "running")
      .length,
    sandboxStartingCount: 0,
    ...(node.maxMvmSlots !== undefined ? { maxSandboxes: node.maxMvmSlots } : {}),
    createSuccesses: 0,
    createFails: 0,
    version: cubelet?.version ?? "",
    commit: cubelet?.commit ?? "",
    machineInfo: { cpuFamily: "", cpuModel: "", cpuModelName: "", cpuArchitecture: "" },
    metrics: {
      allocatedCPU: Math.round((node.capacity.cpuMilli - node.allocatable.cpuMilli) / 1000),
      cpuPercent: Math.round((node.cpuSaturation ?? 0) * 100),
      cpuCount: Math.round(node.capacity.cpuMilli / 1000),
      allocatedMemoryBytes: (node.capacity.memoryMB - node.allocatable.memoryMB) * mib,
      memoryUsedBytes: (node.capacity.memoryMB - node.allocatable.memoryMB) * mib,
      memoryTotalBytes: node.capacity.memoryMB * mib,
      disks: [],
      hugePagesTotal: 0,
      hugePagesUsed: 0,
      hugePagesReserved: 0,
      hugePageSizeBytes: 0,
    },
  };
}

route("GET", /^\/nodes$/, ADMIN, async (ctx, _req, res, _params, url) => {
  requireCluster(ctx, url);
  const upstream = await cubeOps(ctx, "GET", "/nodes");
  if (!upstream.ok) throw new ShimHttpError(502, `CubeOps returned HTTP ${upstream.status}`);
  const nodes = (await upstream.json()) as CubeOpsNode[];
  const sandboxes = await listUserSandboxes(ctx);
  sendJson(res, 200, nodes.map((node) => nodeApi(ctx, node, sandboxes)));
});

route("GET", /^\/nodes\/([^/]+)$/, ADMIN, async (ctx, _req, res, [nodeId], url) => {
  requireCluster(ctx, url);
  const upstream = await cubeOps(ctx, "GET", `/nodes/${encodeURIComponent(nodeId)}`);
  if (upstream.status === 404) throw new ShimHttpError(404, `Node ${nodeId} not found`);
  if (!upstream.ok) throw new ShimHttpError(502, `CubeOps returned HTTP ${upstream.status}`);
  const { sandboxStartingCount: _starting, ...detail } = nodeApi(
    ctx,
    (await upstream.json()) as CubeOpsNode,
    await listUserSandboxes(ctx)
  );
  sendJson(res, 200, detail);
});

route("POST", /^\/nodes\/([^/]+)$/, ADMIN, async (ctx, req, res, [nodeId]) => {
  const body = await readObjectBody(req);
  if (body.clusterID !== undefined && body.clusterID !== ctx.config.clusterId) {
    throw new ShimHttpError(404, `Cluster ${String(body.clusterID)} not found`);
  }
  // CubeOps isolation is Cube's cordon: no new sandboxes, existing ones keep running.
  const method =
    body.status === "draining" || body.status === "standby"
      ? "PUT"
      : body.status === "ready"
        ? "DELETE"
        : null;
  if (!method) {
    throw new ShimHttpError(409, `CubeSandbox nodes can only be set to ready, draining or standby`);
  }
  const upstream = await cubeOps(ctx, method, `/nodes/${encodeURIComponent(nodeId)}/isolation`);
  if (upstream.status === 404) throw new ShimHttpError(404, `Node ${nodeId} not found`);
  if (!upstream.ok) throw new ShimHttpError(502, `CubeOps returned HTTP ${upstream.status}`);
  sendEmpty(res, 204);
});

// Rigs are cloud scaling groups (AWS ASG / GCP MIG) behind E2B's
// orchestrator pools. E2B answers 501 when no rig provider is configured,
// which is always the case for a CubeSandbox deployment.
const noRigs: Handler = async () => {
  throw new ShimHttpError(501, "rigs are not available: CubeSandbox nodes are not managed by a cloud scaling group");
};
route("GET", /^\/clusters\/([^/]+)\/rigs$/, ADMIN, noRigs);
route("PUT", /^\/clusters\/([^/]+)\/rigs\/([^/]+)\/capacity$/, ADMIN, noRigs);
route("DELETE", /^\/clusters\/([^/]+)\/rigs\/instances\/([^/]+)$/, ADMIN, noRigs);
route("GET", /^\/clusters\/([^/]+)\/rigs\/([^/]+)\/instances$/, ADMIN, noRigs);
route("GET", /^\/clusters\/([^/]+)\/rigs\/([^/]+)\/errors$/, ADMIN, noRigs);
