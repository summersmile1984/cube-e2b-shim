/**
 * E2B volume content API (`/volumecontent/{volumeID}/...`, E2B's separate
 * volume-content OpenAPI spec) on CubeSandbox.
 *
 * E2B serves volume files directly from its storage layer. Cube volumes are
 * only reachable from inside a sandbox that mounts them, so the shim keeps a
 * small private helper sandbox per volume (the volume mounted at
 * `/mnt/e2b-volume`) and performs each operation through that sandbox's envd:
 * stat/list via GNU find, reads and writes via envd `/files`, metadata and
 * directory changes via coreutils. Helpers are hidden from sandbox lists and
 * reaped after a few idle minutes.
 *
 * Callers authenticate with the volume token the shim returns from
 * `POST /volumes` and `GET /volumes/{id}` (an HMAC of the volume ID, so it
 * survives restarts and needs no storage).
 */

import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { pipeline } from "node:stream/promises";
import { timingSafeEqual } from "node:crypto";
import type { ShimConfig } from "./config.js";
import type { CubeClient } from "./cube-client.js";
import { INTERNAL_METADATA_PREFIX } from "./events.js";
import {
  EnvdCommandError,
  downloadFile,
  runCommand,
  uploadFile,
  waitForEnvd,
  type EnvdTarget,
} from "./envd-client.js";
import { ShimHttpError, readObjectBody, sendEmpty, sendJson, sendShimError } from "./http-util.js";
import type { Platform } from "./platform.js";

const MOUNT = "/mnt/e2b-volume";
const HELPER_TIMEOUT_SECONDS = 15 * 60;
const HELPER_IDLE_MS = 5 * 60 * 1000;
const HELPER_KEEPALIVE_MS = 5 * 60 * 1000;
const FIELD = "\u001f";
const RECORD = "\u001e";
const FIND_FORMAT = `%y\\037%s\\037%m\\037%U\\037%G\\037%A@\\037%T@\\037%C@\\037%p\\037%l\\036`;

export const VOLUME_HELPER_METADATA_KEY = `${INTERNAL_METADATA_PREFIX}volume-helper`;

interface Helper {
  sandboxId: string;
  lastUsedMs: number;
  lastKeepaliveMs: number;
}

export interface VolumeEntryStat {
  name: string;
  type: "file" | "directory" | "symlink" | "unknown";
  path: string;
  size: number;
  mode: number;
  uid: number;
  gid: number;
  atime: string;
  mtime: string;
  ctime: string;
  target?: string;
}

function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Normalize a caller path to an absolute path inside the volume. */
export function volumePath(raw: string | null): string {
  if (!raw) throw new ShimHttpError(400, "path is required");
  if (raw.includes("\0")) throw new ShimHttpError(400, "path must not contain NUL");
  return posix.normalize(`/${raw}`).replace(/\/+$/, "") || "/";
}

function toSeconds(raw: string): string {
  return new Date(Math.floor(Number.parseFloat(raw) * 1000)).toISOString();
}

/** Parse GNU find output produced with FIND_FORMAT. */
export function parseFindOutput(output: string): VolumeEntryStat[] {
  return output
    .split(RECORD)
    .filter((record) => record.replace(/^\n/, "").length > 0)
    .map((record) => {
      const [type, size, mode, uid, gid, atime, mtime, ctime, fullPath, target] = record
        .replace(/^\n/, "")
        .split(FIELD);
      const inVolume = fullPath === MOUNT ? "/" : fullPath.slice(MOUNT.length) || "/";
      return {
        name: posix.basename(inVolume) || "/",
        type: type === "f" ? "file" : type === "d" ? "directory" : type === "l" ? "symlink" : "unknown",
        path: inVolume,
        size: Number(size),
        mode: Number.parseInt(mode, 8),
        uid: Number(uid),
        gid: Number(gid),
        atime: toSeconds(atime),
        mtime: toSeconds(mtime),
        ctime: toSeconds(ctime),
        ...(type === "l" && target ? { target } : {}),
      };
    });
}

function uintParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new ShimHttpError(400, `${name} must be an unsigned integer`);
  }
  return value;
}

export class VolumeContent {
  private readonly helpers = new Map<string, Helper>();
  private readonly starting = new Map<string, Promise<Helper>>();
  private reaper: NodeJS.Timeout | null = null;

  constructor(
    private readonly config: ShimConfig,
    private readonly cube: CubeClient,
    private readonly platform: Platform,
    private readonly resolveTemplate: (ref: string) => Promise<string>
  ) {}

  /** Stable bearer token for a volume's content API. */
  token(volumeId: string): string {
    return `vol_${this.platform.mac("volume-content", volumeId)}`;
  }

  verify(volumeId: string, req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const given = Buffer.from(header.replace(/^bearer\s+/i, ""));
    const expected = Buffer.from(this.token(volumeId));
    return /^bearer\s+/i.test(header) && given.length === expected.length && timingSafeEqual(given, expected);
  }

  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => void this.reapIdle(), 60_000);
    this.reaper.unref();
  }

  async stop(): Promise<void> {
    if (this.reaper) clearInterval(this.reaper);
    this.reaper = null;
    await Promise.all([...this.helpers.keys()].map((volumeId) => this.release(volumeId)));
  }

  private async reapIdle(): Promise<void> {
    const now = Date.now();
    for (const [volumeId, helper] of this.helpers) {
      if (now - helper.lastUsedMs > HELPER_IDLE_MS) await this.release(volumeId);
    }
  }

  private async release(volumeId: string): Promise<void> {
    const helper = this.helpers.get(volumeId);
    this.helpers.delete(volumeId);
    if (helper) await this.cube.request("DELETE", `/sandboxes/${helper.sandboxId}`).catch(() => undefined);
  }

  private async startHelper(volumeId: string): Promise<Helper> {
    const volume = await this.cube.request("GET", `/volumes/${encodeURIComponent(volumeId)}`);
    if (volume.status === 404) throw new ShimHttpError(404, `Volume ${volumeId} not found`);
    if (volume.status >= 400) throw new ShimHttpError(502, `Cube volume lookup failed: HTTP ${volume.status}`);
    const { name } = JSON.parse(volume.body) as { name?: string };
    if (!name) throw new ShimHttpError(502, "Cube volume has no name");

    const created = await this.cube.request("POST", "/sandboxes", {
      templateID: await this.resolveTemplate(this.config.volumeHelperTemplate),
      timeout: HELPER_TIMEOUT_SECONDS,
      volumeMounts: [{ name, path: MOUNT }],
      metadata: { [VOLUME_HELPER_METADATA_KEY]: volumeId },
    });
    if (created.status >= 400) {
      throw new ShimHttpError(502, `volume helper sandbox failed: HTTP ${created.status} ${created.body}`);
    }
    const sandboxId = String((JSON.parse(created.body) as { sandboxID?: string }).sandboxID ?? "");
    const helper = { sandboxId, lastUsedMs: Date.now(), lastKeepaliveMs: Date.now() };
    try {
      await waitForEnvd(this.envdTarget(helper));
    } catch (error) {
      await this.cube.request("DELETE", `/sandboxes/${sandboxId}`).catch(() => undefined);
      throw error;
    }
    return helper;
  }

  private envdTarget(helper: Helper): EnvdTarget {
    return { proxyUrl: this.config.cubeProxyUrl, cubeDomain: this.config.cubeDomain, sandboxId: helper.sandboxId };
  }

  private async target(volumeId: string): Promise<EnvdTarget> {
    let helper = this.helpers.get(volumeId);
    if (!helper) {
      let pending = this.starting.get(volumeId);
      if (!pending) {
        pending = this.startHelper(volumeId).finally(() => this.starting.delete(volumeId));
        this.starting.set(volumeId, pending);
      }
      helper = await pending;
      this.helpers.set(volumeId, helper);
    }
    helper.lastUsedMs = Date.now();
    if (Date.now() - helper.lastKeepaliveMs > HELPER_KEEPALIVE_MS) {
      helper.lastKeepaliveMs = Date.now();
      void this.cube
        .request("POST", `/sandboxes/${helper.sandboxId}/timeout`, { timeout: HELPER_TIMEOUT_SECONDS })
        .catch(() => undefined);
    }
    return this.envdTarget(helper);
  }

  /** Run a shell command in the volume's helper; retries once with a fresh helper. */
  private async sh(volumeId: string, command: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const target = await this.target(volumeId);
      try {
        return (await runCommand(target, command, { user: "root" })).stdout;
      } catch (error) {
        if (error instanceof EnvdCommandError || attempt > 0) throw error;
        await this.release(volumeId); // helper vanished (TTL, node loss): start over
      }
    }
  }

  /** Exit codes: 3 = not found, 4 = exists, 5 = wrong type. */
  private async check(volumeId: string, command: string): Promise<string> {
    try {
      return await this.sh(volumeId, command);
    } catch (error) {
      if (error instanceof EnvdCommandError) {
        if (error.result.exitCode === 3) throw new ShimHttpError(404, "Path not found");
        if (error.result.exitCode === 4) throw new ShimHttpError(409, "Path already exists");
        if (error.result.exitCode === 5) throw new ShimHttpError(400, error.result.stderr.trim() || "Wrong entry type");
        throw new ShimHttpError(500, error.result.stderr.trim() || error.message);
      }
      throw error;
    }
  }

  private async stat(volumeId: string, path: string): Promise<VolumeEntryStat> {
    const full = MOUNT + (path === "/" ? "" : path);
    const out = await this.check(
      volumeId,
      `[ -e ${q(full)} ] || [ -L ${q(full)} ] || exit 3; find ${q(full)} -maxdepth 0 -printf '${FIND_FORMAT}'`
    );
    const [entry] = parseFindOutput(out);
    if (!entry) throw new ShimHttpError(404, "Path not found");
    return entry;
  }

  private metadataCommand(full: string, uid?: number, gid?: number, mode?: number): string {
    const parts: string[] = [];
    if (uid !== undefined || gid !== undefined) {
      parts.push(`chown -h ${uid ?? ""}${gid !== undefined ? `:${gid}` : ""} ${q(full)}`);
    }
    if (mode !== undefined) parts.push(`chmod ${(mode & 0o7777).toString(8)} ${q(full)}`);
    return parts.join(" && ");
  }

  // -------------------------------------------------------------------------
  // HTTP
  // -------------------------------------------------------------------------

  /** Returns true when the request was a volume-content request. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const match = /^\/volumecontent\/([^/]+)\/(path|dir|file)$/.exec(url.pathname);
    if (!match) return false;
    const volumeId = decodeURIComponent(match[1]);
    const resource = match[2];
    const method = req.method ?? "GET";
    try {
      if (!this.verify(volumeId, req)) {
        sendJson(res, 401, { code: "unauthorized", message: "invalid volume token" });
        return true;
      }
      const path = volumePath(url.searchParams.get("path"));
      const full = MOUNT + (path === "/" ? "" : path);

      if (resource === "path" && method === "GET") {
        sendJson(res, 200, await this.stat(volumeId, path));
      } else if (resource === "path" && method === "PATCH") {
        const body = await readObjectBody(req, true);
        const field = (key: string) => {
          const value = body[key];
          if (value === undefined) return undefined;
          if (!Number.isInteger(value) || (value as number) < 0) throw new ShimHttpError(400, `${key} must be an unsigned integer`);
          return value as number;
        };
        await this.stat(volumeId, path);
        const command = this.metadataCommand(full, field("uid"), field("gid"), field("mode"));
        if (command) await this.check(volumeId, command);
        sendJson(res, 200, await this.stat(volumeId, path));
      } else if (resource === "path" && method === "DELETE") {
        if (path === "/") throw new ShimHttpError(400, "the volume root cannot be deleted");
        await this.check(volumeId, `[ -e ${q(full)} ] || [ -L ${q(full)} ] || exit 3; rm -rf -- ${q(full)}`);
        sendEmpty(res, 204);
      } else if (resource === "dir" && method === "GET") {
        const depth = uintParam(url, "depth") ?? 1;
        if (depth < 1) throw new ShimHttpError(400, "depth must be at least 1");
        const out = await this.check(
          volumeId,
          `[ -e ${q(full)} ] || exit 3; [ -d ${q(full)} ] || { echo "not a directory" >&2; exit 5; }; ` +
            `find ${q(full)} -mindepth 1 -maxdepth ${depth} -printf '${FIND_FORMAT}'`
        );
        sendJson(res, 200, parseFindOutput(out).sort((a, b) => a.path.localeCompare(b.path)));
      } else if (resource === "dir" && method === "POST") {
        const force = url.searchParams.get("force") === "true";
        const parent = posix.dirname(full);
        await this.check(
          volumeId,
          `if [ -e ${q(full)} ]; then [ -d ${q(full)} ] || { echo "path exists and is not a directory" >&2; exit 5; }; ` +
            `else ${force ? `mkdir -p ${q(full)}` : `[ -d ${q(parent)} ] || exit 3; mkdir ${q(full)}`}; fi`
        );
        const command = this.metadataCommand(full, uintParam(url, "uid"), uintParam(url, "gid"), uintParam(url, "mode"));
        if (command) await this.check(volumeId, command);
        sendJson(res, 201, await this.stat(volumeId, path));
      } else if (resource === "file" && method === "GET") {
        const target = await this.target(volumeId);
        await this.check(volumeId, `[ -e ${q(full)} ] || exit 3; [ -f ${q(full)} ] || { echo "not a file" >&2; exit 5; }`);
        const stream = await downloadFile(target, full);
        res.writeHead(200, {
          "Content-Type": "application/octet-stream",
          ...(stream.headers["content-length"] ? { "Content-Length": stream.headers["content-length"] } : {}),
        });
        await pipeline(stream, res);
      } else if (resource === "file" && method === "PUT") {
        const force = url.searchParams.get("force") === "true";
        await this.check(
          volumeId,
          `[ -d ${q(posix.dirname(full))} ] || exit 3; ` +
            `if [ -e ${q(full)} ]; then [ -d ${q(full)} ] && { echo "path is a directory" >&2; exit 5; }; ${force ? "true" : "exit 4"}; fi`
        );
        const spool = await mkdtemp(join(tmpdir(), "shim-volume-"));
        try {
          const local = join(spool, "upload");
          await pipeline(req, createWriteStream(local, { mode: 0o600 }));
          await uploadFile(await this.target(volumeId), local, full, "root");
        } finally {
          await rm(spool, { recursive: true, force: true });
        }
        const command = this.metadataCommand(full, uintParam(url, "uid"), uintParam(url, "gid"), uintParam(url, "mode"));
        if (command) await this.check(volumeId, command);
        sendJson(res, 201, await this.stat(volumeId, path));
      } else {
        sendShimError(res, 405, `Method ${method} not allowed on ${url.pathname}`);
      }
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
      } else if (error instanceof ShimHttpError) {
        sendJson(res, error.status, { code: String(error.status), message: error.message });
      } else {
        sendJson(res, 500, { code: "500", message: error instanceof Error ? error.message : String(error) });
      }
    }
    return true;
  }
}
