/**
 * E2B template catalog APIs over two kinds of templates:
 *  - templates built through the E2B build API, addressed by name[:tag] and
 *    backed by Cube memory snapshots (see template-builder.ts);
 *  - Cube-native templates (from-image, addressed by `tpl-` ID or alias).
 *
 * Both are reported in E2B's `Template` / `TemplateWithBuilds` shapes. The
 * shim's internal artifacts (build snapshots, cached from-image bases) are
 * hidden from Cube's list. Cube cannot update template metadata, so the
 * `public` flag and spawn statistics live in the shim.
 */

import type { ApiContext } from "./api-surface.js";
import { e2bStatusFromCubeStatus, relay, resolveTemplateRef } from "./api-surface.js";
import { ShimHttpError, intParam, readObjectBody, sendEmpty, sendJson } from "./http-util.js";
import { ANY, route } from "./management-api.js";
import type { BuildRow } from "./store.js";

interface CubeTemplateSummary {
  templateID: string;
  public?: boolean;
  status?: string;
  createdAt?: string;
  jobID?: string;
  aliases?: string[];
}

interface CubeTemplateDetail extends CubeTemplateSummary {
  createRequest?: { cpu?: number; memory?: number; writableLayerSize?: string };
}

const TAG_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const DEFAULT_CPU = 2;
const DEFAULT_MEMORY_MB = 512;

/** "4G" / "2048M" / "10Gi" -> MiB. */
export function parseSizeMb(size: string | undefined): number {
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?i?B?$/i.exec(size?.trim() ?? "");
  if (!match) return 0;
  const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 }[(match[2] ?? "M").toUpperCase()] ?? 1;
  return Math.round(Number(match[1]) * factor);
}

function splitRef(ref: string): { name: string; tag: string } {
  const colon = ref.lastIndexOf(":");
  return colon > 0 ? { name: ref.slice(0, colon), tag: ref.slice(colon + 1) } : { name: ref, tag: "default" };
}

function iso(ms: number | null | undefined): string | undefined {
  return ms ? new Date(ms).toISOString() : undefined;
}

function buildResources(build: BuildRow | undefined): { cpuCount: number; memoryMB: number } {
  const request = (build?.request ?? {}) as { cpuCount?: number; memoryMB?: number };
  return { cpuCount: request.cpuCount ?? DEFAULT_CPU, memoryMB: request.memoryMB ?? DEFAULT_MEMORY_MB };
}

function detailResources(detail: CubeTemplateDetail | null) {
  const cpu = detail?.createRequest?.cpu;
  return {
    cpuCount: cpu ? Math.max(1, Math.round(cpu / 1000)) : DEFAULT_CPU,
    memoryMB: detail?.createRequest?.memory ?? DEFAULT_MEMORY_MB,
    diskSizeMB: parseSizeMb(detail?.createRequest?.writableLayerSize),
  };
}

// ---------------------------------------------------------------------------
// Shape builders
// ---------------------------------------------------------------------------

function builtTemplate(ctx: ApiContext, name: string): Record<string, unknown> {
  const builds = ctx.store.listBuilds(name);
  const current = ctx.store.resolveTemplateTag(name);
  const currentBuild = builds.find((b) => b.buildId === current?.buildId) ?? builds[0];
  const meta = ctx.store.getTemplateMeta(name);
  const created = Math.min(...builds.map((b) => b.createdAtMs));
  const updated = Math.max(...builds.map((b) => b.updatedAtMs));
  return {
    templateID: name,
    buildID: currentBuild?.buildId ?? "",
    ...buildResources(currentBuild),
    diskSizeMB: parseSizeMb(ctx.config.templateDiskSize),
    public: meta.public,
    aliases: [name],
    names: [name],
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(updated).toISOString(),
    createdBy: null,
    lastSpawnedAt: meta.lastSpawnedAt,
    spawnCount: meta.spawnCount,
    buildCount: builds.length,
    envdVersion: meta.envdVersion ?? "",
    buildStatus: builds[0]?.status ?? "waiting",
  };
}

function cubeTemplate(ctx: ApiContext, template: CubeTemplateDetail): Record<string, unknown> {
  const meta = ctx.store.getTemplateMeta(template.templateID);
  const createdAt = template.createdAt ?? new Date(0).toISOString();
  return {
    templateID: template.templateID,
    buildID: template.jobID ?? template.templateID,
    ...detailResources(template),
    public: meta.public || template.public === true,
    aliases: template.aliases ?? [],
    names: template.aliases ?? [],
    createdAt,
    updatedAt: createdAt,
    createdBy: null,
    lastSpawnedAt: meta.lastSpawnedAt,
    spawnCount: meta.spawnCount,
    buildCount: 1,
    envdVersion: meta.envdVersion ?? "",
    buildStatus: e2bStatusFromCubeStatus(template.status),
  };
}

async function cubeDetail(ctx: ApiContext, templateId: string): Promise<CubeTemplateDetail | null> {
  const upstream = await ctx.cube.request("GET", `/templates/${encodeURIComponent(templateId)}`);
  if (upstream.status === 404) return null;
  if (upstream.status >= 400) throw new ShimHttpError(upstream.status, upstream.body || "Cube template lookup failed");
  return JSON.parse(upstream.body) as CubeTemplateDetail;
}

/** Every template visible to the team, newest first. */
async function allTemplates(ctx: ApiContext): Promise<Array<Record<string, unknown>>> {
  const { data } = await ctx.cube.requestJson<CubeTemplateSummary[]>("GET", "/templates");
  const visible = data.filter(
    (t) => !ctx.store.isBuiltTemplate(t.templateID) && !ctx.store.isImageTemplate(t.templateID)
  );
  // Cube's list has no resources; fetch details with bounded concurrency.
  const details: CubeTemplateDetail[] = [];
  for (let i = 0; i < visible.length; i += 8) {
    details.push(
      ...(await Promise.all(
        visible.slice(i, i + 8).map(async (t) => ({ ...t, ...((await cubeDetail(ctx, t.templateID).catch(() => null)) ?? {}) }))
      ))
    );
  }
  const templates = [
    ...ctx.store.listTemplateNames().map((name) => builtTemplate(ctx, name)),
    ...details.map((t) => cubeTemplate(ctx, t)),
  ];
  return templates.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** Cube template ID for a non-built reference: alias, `tpl-` ID, or a raw (e.g. snapshot) ID. */
async function cubeIdFor(ctx: ApiContext, ref: string): Promise<string> {
  try {
    return await resolveTemplateRef(ctx, ref);
  } catch (error) {
    if ((error as { status?: unknown }).status === 404) return ref;
    throw error;
  }
}

function offsetCursor(offset: number): string {
  return Buffer.from(`offset:${offset}`, "utf8").toString("base64url");
}

function readCursor(token: string | null): number {
  if (!token) return 0;
  const match = /^offset:(\d+)$/.exec(Buffer.from(token, "base64url").toString("utf8"));
  if (!match) throw new ShimHttpError(400, "invalid nextToken");
  return Number.parseInt(match[1], 10);
}

function requireTeamQuery(ctx: ApiContext, url: URL): void {
  const teamId = url.searchParams.get("teamID");
  if (teamId && teamId !== ctx.platform.teamId) throw new ShimHttpError(403, `Team ${teamId} is not accessible`);
}

// ---------------------------------------------------------------------------
// Tags (registered before /templates/{id} so "tags" is not read as an ID)
// ---------------------------------------------------------------------------

function parseTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((t) => typeof t === "string" && TAG_RE.test(t))) {
    throw new ShimHttpError(400, "tags must be a non-empty list of tag names ([a-zA-Z0-9._-])");
  }
  return [...new Set(value as string[])];
}

route("POST", /^\/templates\/tags$/, ANY, async (ctx, req, res) => {
  const body = await readObjectBody(req);
  if (typeof body.target !== "string" || !body.target) throw new ShimHttpError(400, "target is required");
  const tags = parseTags(body.tags);
  const { name, tag } = splitRef(body.target);
  const target = ctx.store.resolveTemplateTag(name, tag);
  if (!target) throw new ShimHttpError(404, `Template ${body.target} not found`);
  ctx.store.assignTags(name, tags, target.buildId);
  await ctx.builder.retireUnreferencedBuilds(name);
  sendJson(res, 201, { tags, buildID: target.buildId });
});

route("DELETE", /^\/templates\/tags$/, ANY, async (ctx, req, res) => {
  const body = await readObjectBody(req);
  if (typeof body.name !== "string" || !body.name) throw new ShimHttpError(400, "name is required");
  const tags = parseTags(body.tags);
  if (!ctx.store.hasTemplate(body.name)) throw new ShimHttpError(404, `Template ${body.name} not found`);
  if (ctx.store.deleteTags(body.name, tags) === 0) {
    throw new ShimHttpError(404, `Tags ${tags.join(", ")} not found on ${body.name}`);
  }
  await ctx.builder.retireUnreferencedBuilds(body.name);
  sendEmpty(res, 204);
});

route("GET", /^\/templates\/([^/]+)\/tags$/, ANY, async (ctx, _req, res, [ref]) => {
  const { name } = splitRef(ref);
  if (ctx.store.hasTemplate(name)) {
    return sendJson(
      res,
      200,
      ctx.store.listTags(name).map((t) => ({ tag: t.tag, buildID: t.buildId, createdAt: t.createdAt }))
    );
  }
  // Cube-native templates have exactly one build: the implicit default tag.
  const detail = await cubeDetail(ctx, await cubeIdFor(ctx, ref));
  if (!detail) throw new ShimHttpError(404, `Template ${ref} not found`);
  sendJson(res, 200, [
    { tag: "default", buildID: detail.jobID ?? detail.templateID, createdAt: detail.createdAt ?? new Date(0).toISOString() },
  ]);
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

route("GET", /^\/templates$/, ANY, async (ctx, _req, res, _params, url) => {
  requireTeamQuery(ctx, url);
  sendJson(res, 200, await allTemplates(ctx));
});

route("GET", /^\/v2\/templates$/, ANY, async (ctx, _req, res, _params, url) => {
  requireTeamQuery(ctx, url);
  const limit = intParam(url, "limit", 100, 1, 100);
  const offset = readCursor(url.searchParams.get("nextToken"));
  const templates = await allTemplates(ctx);
  const page = templates.slice(offset, offset + limit);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (offset + page.length < templates.length) headers["X-Next-Token"] = offsetCursor(offset + page.length);
  res.writeHead(200, headers);
  res.end(JSON.stringify(page));
});

route("GET", /^\/templates\/([^/]+)$/, ANY, async (ctx, _req, res, [ref], url) => {
  const limit = intParam(url, "limit", 100, 1, 100);
  const offset = readCursor(url.searchParams.get("nextToken"));
  const { name } = splitRef(ref);
  let body: Record<string, unknown>;
  let builds: Array<Record<string, unknown>>;
  if (ctx.store.hasTemplate(name)) {
    const summary = builtTemplate(ctx, name);
    const disk = parseSizeMb(ctx.config.templateDiskSize);
    builds = ctx.store.listBuilds(name).map((build) => ({
      buildID: build.buildId,
      status: build.status,
      createdAt: iso(build.createdAtMs),
      updatedAt: iso(build.updatedAtMs),
      ...(build.finishedAtMs ? { finishedAt: iso(build.finishedAtMs) } : {}),
      ...buildResources(build),
      diskSizeMB: disk,
      envdVersion: summary.envdVersion,
    }));
    body = summary;
  } else {
    const detail = await cubeDetail(ctx, await cubeIdFor(ctx, ref));
    if (!detail) throw new ShimHttpError(404, `Template ${ref} not found`);
    body = cubeTemplate(ctx, detail);
    builds = [
      {
        buildID: body.buildID,
        status: body.buildStatus,
        createdAt: body.createdAt,
        updatedAt: body.updatedAt,
        cpuCount: body.cpuCount,
        memoryMB: body.memoryMB,
        diskSizeMB: body.diskSizeMB,
        envdVersion: body.envdVersion,
      },
    ];
  }
  const page = builds.slice(offset, offset + limit);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (offset + page.length < builds.length) headers["X-Next-Token"] = offsetCursor(offset + page.length);
  res.writeHead(200, headers);
  res.end(
    JSON.stringify({
      templateID: body.templateID,
      public: body.public,
      aliases: body.aliases,
      names: body.names,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
      lastSpawnedAt: body.lastSpawnedAt,
      spawnCount: body.spawnCount,
      builds: page,
    })
  );
});

async function updatePublic(ctx: ApiContext, ref: string, isPublic: unknown): Promise<string[]> {
  if (isPublic !== undefined && typeof isPublic !== "boolean") throw new ShimHttpError(400, "public must be a boolean");
  const { name } = splitRef(ref);
  if (ctx.store.hasTemplate(name)) {
    if (typeof isPublic === "boolean") ctx.store.setTemplatePublic(name, isPublic);
    return [name];
  }
  const detail = await cubeDetail(ctx, await cubeIdFor(ctx, ref));
  if (!detail) throw new ShimHttpError(404, `Template ${ref} not found`);
  if (typeof isPublic === "boolean") ctx.store.setTemplatePublic(detail.templateID, isPublic);
  return detail.aliases ?? [];
}

route("PATCH", /^\/templates\/([^/]+)$/, ANY, async (ctx, req, res, [ref]) => {
  await updatePublic(ctx, ref, (await readObjectBody(req)).public);
  sendEmpty(res, 200);
});

route("PATCH", /^\/v2\/templates\/([^/]+)$/, ANY, async (ctx, req, res, [ref]) => {
  sendJson(res, 200, { names: await updatePublic(ctx, ref, (await readObjectBody(req)).public) });
});

route("DELETE", /^\/templates\/([^/]+)$/, ANY, async (ctx, _req, res, [ref]) => {
  const { name } = splitRef(ref);
  if (ctx.store.hasTemplate(name)) {
    for (const cubeTemplateId of ctx.store.deleteTemplate(name)) {
      await ctx.cube.request("DELETE", `/templates/${encodeURIComponent(cubeTemplateId)}`).catch(() => undefined);
      ctx.store.removeSnapshotToken(cubeTemplateId);
    }
    return sendEmpty(res, 204);
  }
  const templateId = await cubeIdFor(ctx, ref);
  const upstream = await ctx.cube.request("DELETE", `/templates/${encodeURIComponent(templateId)}`);
  if (upstream.status >= 400) return relay(res, upstream);
  ctx.store.removeSnapshotToken(templateId);
  sendEmpty(res, 204);
});

// ---------------------------------------------------------------------------
// Build logs
// ---------------------------------------------------------------------------

const LEVELS = ["debug", "info", "warn", "error"];

route("GET", /^\/templates\/([^/]+)\/builds\/([^/]+)\/logs$/, ANY, async (ctx, _req, res, [ref, buildId], url) => {
  const build = ctx.store.getBuild(buildId);
  if (!build || build.templateId !== splitRef(ref).name) {
    return relay(res, await ctx.cube.request("GET", url.pathname + url.search));
  }
  const limit = intParam(url, "limit", 100, 0, 100);
  const direction = url.searchParams.get("direction") ?? "forward";
  if (direction !== "forward" && direction !== "backward") {
    throw new ShimHttpError(400, "direction must be forward or backward");
  }
  const level = url.searchParams.get("level");
  if (level && !LEVELS.includes(level)) throw new ShimHttpError(400, "invalid level");
  const minLevel = LEVELS.indexOf(level ?? "debug");
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw === null ? null : intParam(url, "cursor", 0, 0, Number.MAX_SAFE_INTEGER);

  let logs = ctx.store
    .getBuildLogs(buildId, 0, Number.MAX_SAFE_INTEGER)
    .filter((entry) => LEVELS.indexOf(entry.level) >= minLevel);
  if (direction === "backward") logs = logs.reverse();
  if (cursor !== null) {
    logs = logs.filter((entry) =>
      direction === "forward" ? Date.parse(entry.timestamp) >= cursor : Date.parse(entry.timestamp) <= cursor
    );
  }
  sendJson(res, 200, { logs: logs.slice(0, limit) });
});
