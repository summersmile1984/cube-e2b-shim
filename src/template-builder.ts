/**
 * E2B template builds (v3 API) executed on CubeSandbox.
 *
 * Cube can only turn an OCI image into a template. E2B's `Template.build()`
 * instead describes a base (`fromTemplate` / `fromImage`) plus RUN, COPY,
 * ENV, WORKDIR and USER steps, a start command and a ready check. E2B's own
 * builder runs those steps inside a live sandbox through envd and snapshots
 * the result; this module does the same on Cube:
 *
 *   1. resolve the base to a Cube template (building one from the image with
 *      Cube's from-image API when needed, cached per image reference);
 *   2. start a private build sandbox from it;
 *   3. replay every step through envd with E2B's exact semantics (the
 *      scripts mirror e2b-dev/infra's orchestrator template commands);
 *   4. write the final env/user/workdir into envd, start `startCmd`, wait for
 *      `readyCmd`;
 *   5. take a Cube full-memory snapshot. Cube serves snapshots as templates,
 *      and the running start command and envd defaults are part of it.
 *
 * The E2B template name maps to the resulting Cube template in the shim
 * store, so `Sandbox.create(name)` and `Template.exists(name)` resolve it.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import type { ShimConfig } from "./config.js";
import type { CubeClient } from "./cube-client.js";
import type { BuildLogEntry, ShimStore, TemplateContext } from "./store.js";
import {
  EnvdCommandError,
  postInit,
  runCommand,
  uploadFile,
  waitForEnvd,
  type EnvdTarget,
  type RunOptions,
} from "./envd-client.js";

export interface TemplateStep {
  type: string;
  args?: string[];
  filesHash?: string;
  force?: boolean;
}

export interface BuildStartRequest {
  fromImage?: string;
  fromTemplate?: string;
  fromImageRegistry?: { type?: string; username?: string; password?: string };
  force?: boolean;
  steps?: TemplateStep[];
  startCmd?: string;
  readyCmd?: string;
}

export interface BuildResources {
  cpuCount?: number;
  memoryMB?: number;
}

/** Sandbox metadata marking the shim's private build sandboxes. */
export const BUILD_SANDBOX_METADATA_KEY = "cube-e2b-shim.build";

const FILES_HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;
const BUILD_SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;
const IMAGE_TEMPLATE_TIMEOUT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const READY_RETRY_MS = 2_000;
const DEFAULT_READY_WAIT = "sleep 20";
const UPLOAD_URL_TTL_SECONDS = 60 * 60;
const MAX_LOG_LINE = 4_000;

class BuildStepError extends Error {
  constructor(
    message: string,
    public readonly step?: string
  ) {
    super(message);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** E2B template references accept `name:tag`; only the name selects a template. */
export function templateNamePart(ref: string): string {
  const colon = ref.lastIndexOf(":");
  return colon > 0 ? ref.slice(0, colon) : ref;
}

/**
 * Base directory of a COPY source inside the uploaded archive. Globs are
 * resolved client-side, so everything from the first glob segment on is
 * dropped (doublestar.SplitPattern semantics used by E2B).
 */
export function copySourceBase(src: string): string {
  const segments = src.split("/");
  const kept: string[] = [];
  for (const segment of segments) {
    if (/[*?[{]/.test(segment)) break;
    kept.push(segment);
  }
  const base = kept.join("/").replace(/\/+$/, "");
  return base === "" ? "." : base;
}

/** Port of e2b-dev/infra `commands/copy_script.sh` (Docker COPY semantics). */
function copyScript(opts: {
  sourcePath: string;
  targetPath: string;
  owner: string;
  permissions: string;
  workdir: string;
  user: string;
}): string {
  return `set -o pipefail
targetPath=${shellQuote(opts.targetPath)}
sourcePath=${shellQuote(opts.sourcePath)}
owner=${shellQuote(opts.owner)}
permissions=${shellQuote(opts.permissions)}
workdir=${shellQuote(opts.workdir)}
user=${shellQuote(opts.user)}
if [ -z "\${workdir}" ]; then
    workdir=$(getent passwd "$user" | cut -d: -f6)
fi
cd "$workdir" || exit 1
sourceFolder="$(dirname "$sourcePath")"
inputPath="$targetPath"
if [[ "$inputPath" = /* ]]; then
    targetPath="$inputPath"
else
    targetPath="$(pwd)/$inputPath"
fi
cd "$sourceFolder" || exit 1
entry="$(basename "$sourcePath")"
if [ ! -e "$entry" ] && [ ! -L "$entry" ]; then
    echo "Error: source path does not exist: $sourcePath"
    exit 1
fi
if [ -L "$entry" ]; then
    if [[ "$targetPath" == */ ]]; then mkdir -p "$targetPath"; else mkdir -p "$(dirname "$targetPath")"; fi
    chown -h "$owner" "$entry"
    mv "$entry" "$targetPath"
elif [ -f "$entry" ]; then
    chown "$owner" "$entry"
    if [ -n "$permissions" ]; then chmod "$permissions" "$entry"; fi
    if [[ "$targetPath" == */ ]]; then mkdir -p "$targetPath"; else mkdir -p "$(dirname "$targetPath")"; fi
    mv "$entry" "$targetPath"
elif [ -d "$entry" ]; then
    chown -R "$owner" "$entry"
    if [ -n "$permissions" ]; then chmod -R "$permissions" "$entry"; fi
    mkdir -p "$targetPath"
    (cd "$entry" && tar -cf - .) | tar -xf - -C "$targetPath" --keep-directory-symlink --no-overwrite-dir || exit 1
    chmod -R u+rwx "$entry"
    rm -rf "$entry"
else
    echo "Error: entry is neither file, directory, nor symlink"
    exit 1
fi`;
}

/** Port of e2b-dev/infra `commands/workdir.go`. */
function workdirScript(target: string, user: string): string {
  return `target=${shellQuote(target)}
if [ -d "$target" ]; then exit 0; fi
first_new=""
check="$target"
while [ ! -d "$check" ]; do
    first_new="$check"
    check=$(dirname "$check")
done
if [ -n "$first_new" ]; then
    mkdir -p "$target" && chown -R ${shellQuote(`${user}:${user}`)} "$first_new"
fi`;
}

/** Port of e2b-dev/infra `commands/user.go` sudo provisioning. */
function sudoScript(user: string): string {
  const u = shellQuote(user);
  return `if [ -f /usr/local/share/e2b/distro.env ]; then . /usr/local/share/e2b/distro.env; fi
if [ -n "\${E2B_ADMIN_GROUP:-}" ]; then
    getent group "$E2B_ADMIN_GROUP" >/dev/null || { echo "admin group $E2B_ADMIN_GROUP missing" >&2; exit 1; }
    usermod -aG "$E2B_ADMIN_GROUP" ${u}
elif getent group sudo >/dev/null; then
    usermod -aG sudo ${u}
elif getent group wheel >/dev/null; then
    usermod -aG wheel ${u}
else
    echo "neither the sudo nor the wheel group exists on this image" >&2
    exit 1
fi
passwd -d ${u} >/dev/null 2>&1 || true
if [ -d /etc/sudoers.d ]; then
    echo ${shellQuote(`${user} ALL=(ALL:ALL) NOPASSWD: ALL`)} > /etc/sudoers.d/${user.replace(/[^A-Za-z0-9_-]/g, "_")}
    chmod 0440 /etc/sudoers.d/${user.replace(/[^A-Za-z0-9_-]/g, "_")}
fi`;
}

interface BuildState {
  /** User that executes the next step (E2B's build context user). */
  user: string;
  workdir?: string;
  envVars: Record<string, string>;
  /** Default user persisted into envd; only set by USER or an inherited base. */
  defaultUser?: string;
}

export interface TemplateBuilderOptions {
  /** Directory for uploaded COPY archives. */
  filesDir: string;
  /** Writable layer size for Cube from-image templates. */
  writableLayerSize: string;
}

export class TemplateBuilder {
  private readonly uploadSecret = randomBytes(32);
  private readonly running = new Map<string, AbortController>();

  constructor(
    private readonly config: ShimConfig,
    private readonly store: ShimStore,
    private readonly cube: CubeClient,
    private readonly options: TemplateBuilderOptions,
    /** Resolves a non-shim template reference (Cube ID or alias). */
    private readonly resolveCubeTemplate: (ref: string) => Promise<string>
  ) {
    mkdirSync(options.filesDir, { recursive: true, mode: 0o700 });
  }

  // -------------------------------------------------------------------------
  // COPY archives: presigned upload URL, unauthenticated PUT, local cache
  // -------------------------------------------------------------------------

  isValidFilesHash(hash: string): boolean {
    return FILES_HASH_RE.test(hash);
  }

  hasFiles(hash: string): boolean {
    return this.isValidFilesHash(hash) && existsSync(this.filesPath(hash));
  }

  private filesPath(hash: string): string {
    return join(this.options.filesDir, `${hash}.tar`);
  }

  private uploadSignature(hash: string, expires: number): string {
    return createHmac("sha256", this.uploadSecret)
      .update(`${hash}:${expires}`)
      .digest("base64url");
  }

  /** Presigned-style upload path (the caller prefixes the public API origin). */
  uploadPath(hash: string): string {
    const expires = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_SECONDS;
    const query = new URLSearchParams({
      expires: String(expires),
      signature: this.uploadSignature(hash, expires),
    });
    return `/template-files/${hash}?${query.toString()}`;
  }

  verifyUpload(hash: string, url: URL): boolean {
    if (!this.isValidFilesHash(hash)) return false;
    const expires = Number.parseInt(url.searchParams.get("expires") ?? "", 10);
    const signature = url.searchParams.get("signature") ?? "";
    if (!Number.isFinite(expires) || expires * 1000 < Date.now()) return false;
    const expected = Buffer.from(this.uploadSignature(hash, expires));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  async receiveUpload(hash: string, req: IncomingMessage): Promise<void> {
    const target = this.filesPath(hash);
    const partial = `${target}.${randomBytes(6).toString("hex")}.part`;
    try {
      await pipeline(req, createWriteStream(partial, { mode: 0o600 }));
      await rename(partial, target);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Build execution
  // -------------------------------------------------------------------------

  isRunning(buildId: string): boolean {
    return this.running.has(buildId);
  }

  /** Validate a build request before accepting it; returns an error message. */
  validate(request: BuildStartRequest): string | null {
    if (!request.fromImage && !request.fromTemplate) {
      return "fromImage or fromTemplate is required";
    }
    if (request.fromImage && request.fromTemplate) {
      return "fromImage and fromTemplate are mutually exclusive";
    }
    const registryType = request.fromImageRegistry?.type;
    if (registryType && registryType !== "registry") {
      return `fromImageRegistry type '${registryType}' is not supported by Cube (use 'registry')`;
    }
    for (const [index, step] of (request.steps ?? []).entries()) {
      const type = String(step.type ?? "").toUpperCase();
      if (!["RUN", "COPY", "ENV", "WORKDIR", "USER"].includes(type)) {
        return `step ${index + 1}: unsupported type '${step.type}'`;
      }
      if (type === "COPY") {
        if (!step.filesHash || !this.isValidFilesHash(step.filesHash)) {
          return `step ${index + 1}: COPY requires a filesHash`;
        }
        if (!this.hasFiles(step.filesHash)) {
          return `step ${index + 1}: files for hash ${step.filesHash} were not uploaded`;
        }
      }
    }
    return null;
  }

  /** Start a validated build in the background. */
  start(buildId: string, name: string, request: BuildStartRequest, resources: BuildResources): void {
    const controller = new AbortController();
    this.running.set(buildId, controller);
    this.store.setBuildStatus(buildId, "building");
    void this.execute(buildId, name, request, resources, controller.signal).finally(() =>
      this.running.delete(buildId)
    );
  }

  /** Cancel every running build; each fails with "build cancelled" and cleans up. */
  cancelAll(): number {
    let cancelled = 0;
    for (const controller of this.running.values()) {
      if (controller.signal.aborted) continue;
      controller.abort(new BuildStepError("build cancelled"));
      cancelled++;
    }
    return cancelled;
  }

  private log(buildId: string, level: BuildLogEntry["level"], message: string, step?: string): void {
    const text = message.length > MAX_LOG_LINE ? `${message.slice(0, MAX_LOG_LINE)}…` : message;
    this.store.appendBuildLog(buildId, {
      timestamp: new Date().toISOString(),
      level,
      message: text,
      ...(step ? { step } : {}),
    });
  }

  private target(sandboxId: string): EnvdTarget {
    return {
      proxyUrl: this.config.cubeProxyUrl,
      cubeDomain: this.config.cubeDomain,
      sandboxId,
    };
  }

  private async execute(
    buildId: string,
    name: string,
    request: BuildStartRequest,
    resources: BuildResources,
    signal: AbortSignal
  ): Promise<void> {
    let sandboxId: string | null = null;
    let currentStep: string | undefined;
    try {
      this.log(buildId, "info", `Building template ${name} (build ${buildId}) on CubeSandbox`);
      const { cubeTemplateId, context } = await this.resolveBase(buildId, request, resources);

      currentStep = "base";
      signal.throwIfAborted();
      sandboxId = await this.startBuildSandbox(buildId, cubeTemplateId);
      const target = { ...this.target(sandboxId), signal };
      await waitForEnvd(target);

      const state: BuildState = {
        user: context.user ?? "root",
        workdir: context.workdir,
        envVars: { ...context.envVars },
        defaultUser: context.user,
      };

      const steps = request.steps ?? [];
      for (const [index, step] of steps.entries()) {
        signal.throwIfAborted();
        currentStep = `${index + 1}`;
        const type = String(step.type).toUpperCase();
        this.log(
          buildId,
          "info",
          `[${index + 1}/${steps.length}] ${type} ${(step.args ?? []).join(" ")}`.trim(),
          currentStep
        );
        await this.runStep(buildId, target, state, step, currentStep);
      }

      signal.throwIfAborted();
      currentStep = "finalize";
      await this.finalize(buildId, target, state, request);

      signal.throwIfAborted();
      this.log(buildId, "info", "Snapshotting build sandbox into a Cube template");
      const snapshot = await this.cube.request("POST", `/sandboxes/${sandboxId}/snapshots`, {
        name: `${name}-${buildId.slice(0, 8)}`,
      });
      if (snapshot.status >= 400) {
        throw new BuildStepError(`Cube snapshot failed: HTTP ${snapshot.status} ${snapshot.body}`);
      }
      const snapshotId = (JSON.parse(snapshot.body) as { snapshotID?: string }).snapshotID;
      if (!snapshotId) throw new BuildStepError("Cube snapshot response did not contain snapshotID");

      const previous = this.store.getTemplateName(name);
      this.store.setTemplateName(name, snapshotId, buildId, {
        ...(state.defaultUser ? { user: state.defaultUser } : {}),
        ...(state.workdir ? { workdir: state.workdir } : {}),
        envVars: state.envVars,
      });
      if (previous && previous.cubeTemplateId !== snapshotId) {
        // Superseded build: Cube tombstones a template still referenced by
        // running sandboxes and reclaims it later, so this is safe.
        await this.cube
          .request("DELETE", `/templates/${encodeURIComponent(previous.cubeTemplateId)}`)
          .catch(() => undefined);
      }
      this.log(buildId, "info", `Template ${name} is ready (Cube template ${snapshotId})`);
      this.store.setBuildStatus(buildId, "ready");
    } catch (error) {
      const message = signal.aborted
        ? "build cancelled"
        : error instanceof Error
          ? error.message
          : String(error);
      this.log(buildId, "error", message, currentStep);
      this.store.setBuildStatus(buildId, "error", {
        message,
        ...(currentStep ? { step: currentStep } : {}),
        logEntries: this.store.getBuildLogs(buildId, 0, 10_000).slice(-20),
      });
    } finally {
      if (sandboxId) {
        await this.cube.request("DELETE", `/sandboxes/${sandboxId}`).catch(() => undefined);
      }
    }
  }

  private async resolveBase(
    buildId: string,
    request: BuildStartRequest,
    resources: BuildResources
  ): Promise<{ cubeTemplateId: string; context: TemplateContext }> {
    if (request.fromTemplate) {
      const shimTemplate = this.store.getTemplateName(templateNamePart(request.fromTemplate));
      if (shimTemplate) {
        this.log(buildId, "info", `Base: template ${request.fromTemplate}`);
        return { cubeTemplateId: shimTemplate.cubeTemplateId, context: shimTemplate.context };
      }
      const cubeTemplateId = await this.resolveCubeTemplate(request.fromTemplate);
      this.log(buildId, "info", `Base: Cube template ${cubeTemplateId} (${request.fromTemplate})`);
      return { cubeTemplateId, context: { envVars: {} } };
    }

    const image = request.fromImage as string;
    const cached = this.store.getImageTemplate(image);
    if (cached && !request.force) {
      const detail = await this.cube.request("GET", `/templates/${encodeURIComponent(cached)}`);
      if (detail.status < 400 && (JSON.parse(detail.body) as { status?: string }).status === "READY") {
        this.log(buildId, "info", `Base: image ${image} (cached Cube template ${cached})`);
        return { cubeTemplateId: cached, context: { envVars: {} } };
      }
      this.store.removeImageTemplate(image);
    }

    this.log(buildId, "info", `Base: building Cube template from image ${image}`);
    const registry = request.fromImageRegistry;
    const created = await this.cube.request("POST", "/templates", {
      image,
      writableLayerSize: this.options.writableLayerSize,
      ...(resources.cpuCount ? { cpu: resources.cpuCount * 1000 } : {}),
      ...(resources.memoryMB ? { memory: resources.memoryMB } : {}),
      ...(registry?.username ? { registryUsername: registry.username } : {}),
      ...(registry?.password ? { registryPassword: registry.password } : {}),
    });
    if (created.status >= 400) {
      throw new BuildStepError(`Cube image template failed: HTTP ${created.status} ${created.body}`, "base");
    }
    const cubeTemplateId = String((JSON.parse(created.body) as { templateID?: string }).templateID ?? "");
    if (!cubeTemplateId) throw new BuildStepError("Cube did not return a templateID", "base");

    const deadline = Date.now() + IMAGE_TEMPLATE_TIMEOUT_MS;
    let lastStatus = "";
    while (Date.now() < deadline) {
      const detail = await this.cube.request("GET", `/templates/${encodeURIComponent(cubeTemplateId)}`);
      if (detail.status < 400) {
        const status = String((JSON.parse(detail.body) as { status?: string }).status ?? "");
        if (status !== lastStatus) {
          this.log(buildId, "info", `Cube image template ${cubeTemplateId}: ${status}`, "base");
          lastStatus = status;
        }
        if (status === "READY") {
          this.store.setImageTemplate(image, cubeTemplateId);
          return { cubeTemplateId, context: { envVars: {} } };
        }
        if (status === "ERROR" || status === "FAILED") {
          throw new BuildStepError(`Cube image template ${cubeTemplateId} failed`, "base");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    throw new BuildStepError(`Cube image template ${cubeTemplateId} was not ready in time`, "base");
  }

  private async startBuildSandbox(buildId: string, cubeTemplateId: string): Promise<string> {
    const created = await this.cube.request("POST", "/sandboxes", {
      templateID: cubeTemplateId,
      timeout: BUILD_SANDBOX_TIMEOUT_SECONDS,
      metadata: { [BUILD_SANDBOX_METADATA_KEY]: buildId },
    });
    if (created.status >= 400) {
      throw new BuildStepError(`build sandbox create failed: HTTP ${created.status} ${created.body}`, "base");
    }
    const sandboxId = String((JSON.parse(created.body) as { sandboxID?: string }).sandboxID ?? "");
    if (!sandboxId) throw new BuildStepError("build sandbox create returned no sandboxID", "base");
    this.log(buildId, "debug", `Build sandbox ${sandboxId} started`, "base");
    return sandboxId;
  }

  private commandOptions(buildId: string, state: BuildState, step: string, user?: string): RunOptions {
    return {
      user: user ?? state.user,
      cwd: state.workdir,
      envs: state.envVars,
      onOutput: (stream, text) => {
        for (const line of text.split("\n")) {
          if (line.trim()) this.log(buildId, stream === "stderr" ? "warn" : "info", line, step);
        }
      },
    };
  }

  private async run(target: EnvdTarget, command: string, options: RunOptions, step: string): Promise<string> {
    try {
      return (await runCommand(target, command, options)).stdout;
    } catch (error) {
      if (error instanceof EnvdCommandError) {
        throw new BuildStepError(`step ${step} failed: ${error.message}`, step);
      }
      throw error;
    }
  }

  private async runStep(
    buildId: string,
    target: EnvdTarget,
    state: BuildState,
    step: TemplateStep,
    stepId: string
  ): Promise<void> {
    const args = step.args ?? [];
    switch (String(step.type).toUpperCase()) {
      case "RUN": {
        if (!args[0]) throw new BuildStepError("RUN requires a command", stepId);
        await this.run(target, args[0], this.commandOptions(buildId, state, stepId, args[1] || undefined), stepId);
        return;
      }
      case "ENV": {
        if (args.length === 0 || args.length % 2 !== 0) {
          throw new BuildStepError("ENV requires key/value pairs", stepId);
        }
        for (let i = 0; i < args.length; i += 2) {
          // Values are shell-evaluated as root without the build env, like E2B.
          const escaped = args[i + 1]
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/`/g, "\\`")
            .replace(/\$\(/g, "\\$(");
          state.envVars[args[i]] = await this.run(
            target,
            `printf "%s" "${escaped}"`,
            { user: "root" },
            stepId
          );
        }
        return;
      }
      case "WORKDIR": {
        if (!args[0]) throw new BuildStepError("WORKDIR requires a path", stepId);
        const base = state.workdir ?? "/";
        const workdir = args[0].startsWith("/") ? args[0] : `${base.replace(/\/+$/, "")}/${args[0]}`;
        await this.run(
          target,
          workdirScript(workdir, state.user),
          { user: "root", envs: state.envVars },
          stepId
        );
        state.workdir = workdir;
        return;
      }
      case "USER": {
        const user = args[0];
        if (!user) throw new BuildStepError("USER requires a username", stepId);
        const q = shellQuote(user);
        await this.run(
          target,
          `id -u ${q} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${q}`,
          { user: "root", envs: state.envVars },
          stepId
        );
        if (args[1] === "true") {
          await this.run(target, sudoScript(user), { user: "root", envs: state.envVars }, stepId);
        }
        state.user = user;
        state.defaultUser = user;
        return;
      }
      case "COPY": {
        const hash = step.filesHash;
        if (!hash || !this.hasFiles(hash)) throw new BuildStepError("COPY files are missing", stepId);
        if (args.length < 2) throw new BuildStepError("COPY requires a source and a target", stepId);
        const archive = `/tmp/${hash}.tar`;
        const unpack = `/tmp/${hash}/unpack`;
        await uploadFile(target, this.filesPath(hash), archive, "root");
        await this.run(
          target,
          `rm -rf ${shellQuote(unpack)} && mkdir -p ${shellQuote(unpack)} && tar -xf ${shellQuote(archive)} -C ${shellQuote(unpack)}`,
          { user: "root", envs: state.envVars },
          stepId
        );
        let owner = `${state.user}:${state.user}`;
        if (args[2]) owner = args[2].includes(":") ? args[2] : `${args[2]}:${args[2]}`;
        const source = copySourceBase(args[0]);
        await this.run(
          target,
          copyScript({
            sourcePath: source === "." ? unpack : `${unpack}/${source}`,
            targetPath: args[1],
            owner,
            permissions: args[3] ?? "",
            workdir: state.workdir ?? "",
            user: state.user,
          }),
          { user: "root", envs: state.envVars },
          stepId
        );
        await this.run(
          target,
          `rm -rf ${shellQuote(`/tmp/${hash}`)} ${shellQuote(archive)}`,
          { user: "root" },
          stepId
        );
        return;
      }
      default:
        throw new BuildStepError(`unsupported step type ${step.type}`, stepId);
    }
  }

  private async finalize(
    buildId: string,
    target: EnvdTarget,
    state: BuildState,
    request: BuildStartRequest
  ): Promise<void> {
    // Persist the final context into envd. The snapshot captures envd's
    // memory, so every sandbox restored from this template starts with it.
    const init: Record<string, unknown> = {};
    if (Object.keys(state.envVars).length > 0) init.envVars = state.envVars;
    if (state.defaultUser) init.defaultUser = state.defaultUser;
    if (state.workdir) init.defaultWorkdir = state.workdir;
    if (Object.keys(init).length > 0) {
      const status = await postInit(target, init);
      if (status < 200 || status >= 300) {
        throw new BuildStepError(`envd rejected the template defaults: HTTP ${status}`, "finalize");
      }
    }

    if (!request.startCmd && !request.readyCmd) return;

    const abort = new AbortController();
    let startFailure: string | null = null;
    if (request.startCmd) {
      this.log(buildId, "info", `Running start command: ${request.startCmd}`, "start");
      await runCommand(target, request.startCmd, {
        ...this.commandOptions(buildId, state, "start"),
        detachAfterStart: true,
        signal: abort.signal,
        onExit: (result) => {
          if (result.exitCode !== 0) startFailure = `start command exited with code ${result.exitCode}`;
        },
      });
    }

    const readyCmd = request.readyCmd || (request.startCmd ? DEFAULT_READY_WAIT : "sleep 0");
    this.log(buildId, "info", `Waiting for template to be ready: ${readyCmd}`, "ready");
    const deadline = Date.now() + READY_TIMEOUT_MS;
    try {
      for (;;) {
        if (startFailure) throw new BuildStepError(startFailure, "start");
        try {
          await runCommand(target, readyCmd, {
            ...this.commandOptions(buildId, state, "ready"),
            timeoutMs: READY_TIMEOUT_MS,
          });
          break;
        } catch (error) {
          if (!(error instanceof EnvdCommandError)) throw error;
          if (Date.now() > deadline) {
            throw new BuildStepError("ready command timed out", "ready");
          }
          await new Promise((resolve) => setTimeout(resolve, READY_RETRY_MS));
        }
      }
      if (startFailure) throw new BuildStepError(startFailure, "start");
      this.log(buildId, "info", "Template is ready", "ready");
    } finally {
      // Stop watching the start command; envd keeps the process running and
      // the memory snapshot preserves it.
      abort.abort();
    }
  }
}
