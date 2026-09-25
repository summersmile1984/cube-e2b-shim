/** Small HTTP helpers shared by the API route modules. */

import type { IncomingMessage, ServerResponse } from "node:http";

export class ShimHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "ShimHttpError";
  }
}

export async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readBody(req);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw new ShimHttpError(400, "Invalid JSON body");
  }
}

/** Parse a JSON object body; rejects arrays, scalars and (unless optional) empty bodies. */
export async function readObjectBody(
  req: IncomingMessage,
  optional = false
): Promise<Record<string, unknown>> {
  const body = await readJsonBody(req);
  if (body === undefined && optional) return {};
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new ShimHttpError(400, "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

/** Bodyless response with an explicit zero length (SDKs parse any other body as JSON). */
export function sendEmpty(res: ServerResponse, status: number): void {
  res.writeHead(status, { "Content-Length": "0" });
  res.end();
}

export function sendShimError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { code: status, message });
}

/** Parse a bounded integer query parameter; throws 400 when malformed. */
export function intParam(
  url: URL,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ShimHttpError(400, `${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/** Repeated or comma-separated query values (`?types=a&types=b` or `?types=a,b`). */
export function listParam(url: URL, name: string): string[] {
  return url.searchParams
    .getAll(name)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}
