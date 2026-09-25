/**
 * Minimal private envd client used by the template builder.
 *
 * Talks to envd through cube-proxy (routing on Host) exactly like the shim's
 * other private envd calls, without any dependency: process execution uses
 * envd's Connect RPC (`process.Process/Start`, server-streaming) with the JSON
 * codec, and file upload uses envd's REST `POST /files` multipart endpoint.
 */

import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

export const ENVD_PORT = 49983;

export interface EnvdTarget {
  /** cube-proxy base URL (http). */
  proxyUrl: string;
  /** Cube's internal sandbox domain. */
  cubeDomain: string;
  sandboxId: string;
  /** envd access token, when the sandbox's envd holds one. */
  accessToken?: string | null;
}

export interface RunOptions {
  user?: string;
  cwd?: string;
  envs?: Record<string, string>;
  /** Called for every stdout/stderr chunk as it arrives. */
  onOutput?: (stream: "stdout" | "stderr", text: string) => void;
  /** Hard limit for the whole command. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Resolve as soon as envd reports the process started, leaving it running
   * inside the sandbox (envd keeps processes alive after the stream closes).
   * `onExit` then receives the result if it ends while still being watched.
   */
  detachAfterStart?: boolean;
  onExit?: (result: CommandResult) => void;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}

export class EnvdCommandError extends Error {
  constructor(
    message: string,
    public readonly result: CommandResult
  ) {
    super(message);
    this.name = "EnvdCommandError";
  }
}

function hostHeader(target: EnvdTarget): string {
  return `${ENVD_PORT}-${target.sandboxId}.${target.cubeDomain}`;
}

function baseHeaders(target: EnvdTarget, user?: string): Record<string, string> {
  const headers: Record<string, string> = { Host: hostHeader(target) };
  if (target.accessToken) headers["X-Access-Token"] = target.accessToken;
  // envd selects the acting user from HTTP Basic auth with an empty password.
  if (user) headers.Authorization = `Basic ${Buffer.from(`${user}:`).toString("base64")}`;
  return headers;
}

function proxyAddress(target: EnvdTarget): { hostname: string; port: number } {
  const url = new URL(target.proxyUrl);
  return { hostname: url.hostname, port: Number(url.port) || 80 };
}

/** Frame one Connect streaming message: flags(1) + big-endian length(4) + payload. */
function envelope(payload: Buffer, flags = 0): Buffer {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

interface ProcessEvent {
  start?: { pid?: number };
  data?: { stdout?: string; stderr?: string; pty?: string };
  end?: { exitCode?: number; exited?: boolean; status?: string; error?: string };
  keepalive?: Record<string, never>;
}

/**
 * Parse a Connect server stream. Calls `onMessage` for each data envelope and
 * returns the end-of-stream error, if any.
 */
function readConnectStream(
  response: IncomingMessage,
  onMessage: (message: { event?: ProcessEvent }) => void
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let endError: string | undefined;
    response.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 5) {
        const flags = buffer.readUInt8(0);
        const length = buffer.readUInt32BE(1);
        if (buffer.length < 5 + length) break;
        const payload = buffer.subarray(5, 5 + length).toString("utf8");
        buffer = buffer.subarray(5 + length);
        try {
          const parsed = payload ? (JSON.parse(payload) as Record<string, unknown>) : {};
          if (flags & 0x02) {
            const error = parsed.error as { code?: string; message?: string } | undefined;
            if (error) endError = `${error.code ?? "unknown"}: ${error.message ?? ""}`.trim();
          } else {
            onMessage(parsed as { event?: ProcessEvent });
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    response.on("end", () => resolve(endError));
    response.on("error", reject);
  });
}

/**
 * Run `/bin/bash -l -c <command>` in the sandbox, the way E2B's template
 * builder runs every step. Rejects with EnvdCommandError on a non-zero exit.
 */
export function runCommand(
  target: EnvdTarget,
  command: string,
  options: RunOptions = {}
): Promise<CommandResult> {
  const { hostname, port } = proxyAddress(target);
  const envs = { ...(options.envs ?? {}) };
  // Same safety net as E2B: a user-provided PATH never hides system tools.
  if (envs.PATH !== undefined) {
    envs.PATH += ":/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
  }
  const requestBody = {
    process: {
      cmd: "/bin/bash",
      args: ["-l", "-c", command],
      envs,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    },
    stdin: false,
  };
  const payload = envelope(Buffer.from(JSON.stringify(requestBody), "utf8"));
  const timeoutMs = options.timeoutMs ?? 60 * 60 * 1000;

  return new Promise<CommandResult>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exit: ProcessEvent["end"] | undefined;
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    const req = httpRequest(
      {
        hostname,
        port,
        method: "POST",
        path: "/process.Process/Start",
        headers: {
          ...baseHeaders(target, options.user),
          "Content-Type": "application/connect+json",
          "Connect-Protocol-Version": "1",
          "Connect-Timeout-Ms": String(timeoutMs),
          "Keepalive-Ping-Interval": "50",
          "Content-Length": String(payload.length),
        },
        timeout: timeoutMs,
        signal: options.signal,
      },
      (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          let body = "";
          response.on("data", (c: Buffer) => (body += c.toString("utf8")));
          response.on("end", () =>
            settle(() =>
              reject(new Error(`envd process start failed: HTTP ${response.statusCode} ${body}`))
            )
          );
          return;
        }
        readConnectStream(response, (message) => {
          const event = message.event;
          if (!event) return;
          if (event.start && options.detachAfterStart) {
            settle(() => resolve({ exitCode: 0, stdout: "", stderr: "" }));
          }
          if (event.data?.stdout) {
            const text = Buffer.from(event.data.stdout, "base64").toString("utf8");
            stdout += text;
            options.onOutput?.("stdout", text);
          }
          if (event.data?.stderr) {
            const text = Buffer.from(event.data.stderr, "base64").toString("utf8");
            stderr += text;
            options.onOutput?.("stderr", text);
          }
          if (event.end) exit = event.end;
        })
          .then((endError) => {
            const result: CommandResult = {
              exitCode: exit?.exitCode ?? (endError ? -1 : 0),
              stdout,
              stderr,
              error: exit?.error ?? endError,
            };
            options.onExit?.(result);
            if (result.exitCode !== 0 || (!exit && endError)) {
              settle(() =>
                reject(
                  new EnvdCommandError(
                    `command exited with code ${result.exitCode}${result.error ? ` (${result.error})` : ""}`,
                    result
                  )
                )
              );
            } else {
              settle(() => resolve(result));
            }
          })
          .catch((error: unknown) =>
            settle(() => reject(error instanceof Error ? error : new Error(String(error))))
          );
      }
    );
    req.on("timeout", () => req.destroy(new Error(`command timed out after ${timeoutMs} ms`)));
    req.on("error", (error) => settle(() => reject(error)));
    req.end(payload);
  });
}

/** Upload a local file into the sandbox through envd's multipart `POST /files`. */
export async function uploadFile(
  target: EnvdTarget,
  localPath: string,
  remotePath: string,
  user = "root"
): Promise<void> {
  const { hostname, port } = proxyAddress(target);
  const { size } = await stat(localPath);
  const boundary = `----cube-e2b-shim-${randomBytes(12).toString("hex")}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="upload"\r\n` +
      `Content-Type: application/octet-stream\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const query = new URLSearchParams({ path: remotePath, username: user });

  await new Promise<void>((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        method: "POST",
        path: `/files?${query.toString()}`,
        headers: {
          ...baseHeaders(target),
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(head.length + size + tail.length),
        },
        timeout: 30 * 60 * 1000,
      },
      (response) => {
        let body = "";
        response.on("data", (c: Buffer) => (body += c.toString("utf8")));
        response.on("end", () => {
          const status = response.statusCode ?? 502;
          if (status >= 200 && status < 300) resolve();
          else reject(new Error(`envd file upload failed: HTTP ${status} ${body}`));
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("envd file upload timed out")));
    req.on("error", reject);
    req.write(head);
    const file = createReadStream(localPath);
    file.on("error", (error) => req.destroy(error));
    file.on("end", () => req.end(tail));
    file.pipe(req, { end: false });
  });
}

/** Poll envd's unauthenticated `/health` until it answers or the deadline passes. */
export async function waitForEnvd(target: EnvdTarget, timeoutMs = 60_000): Promise<void> {
  const { hostname, port } = proxyAddress(target);
  const deadline = Date.now() + timeoutMs;
  let lastError = "no response";
  while (Date.now() < deadline) {
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        { hostname, port, method: "GET", path: "/health", headers: baseHeaders(target), timeout: 5_000 },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode ?? 0));
        }
      );
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(0));
      req.end();
    });
    if (status >= 200 && status < 300) return;
    lastError = status ? `HTTP ${status}` : "unreachable";
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`envd did not become healthy: ${lastError}`);
}

/** POST envd `/init` (private: build-time defaults such as envVars/defaultUser/defaultWorkdir). */
export function postInit(target: EnvdTarget, body: Record<string, unknown>): Promise<number> {
  const { hostname, port } = proxyAddress(target);
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname,
        port,
        method: "POST",
        path: "/init",
        headers: {
          ...baseHeaders(target),
          "Content-Type": "application/json",
          "Content-Length": String(payload.length),
        },
        timeout: 15_000,
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 502));
      }
    );
    req.on("timeout", () => req.destroy(new Error("envd init timed out")));
    req.on("error", reject);
    req.end(payload);
  });
}
