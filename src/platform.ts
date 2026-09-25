/**
 * Single-team platform identity, encryption at rest and caller
 * authentication for the E2B control plane the shim exposes.
 *
 * E2B is multi-tenant; a self-hosted CubeSandbox deployment behind this shim
 * is one team. Every team-scoped E2B API therefore resolves to that team, and
 * a request naming another team (X-Team-ID or a teamID path segment) is
 * refused.
 *
 * Callers authenticate the way E2B's OpenAPI security schemes describe:
 *  - `X-API-Key`: a SHIM_API_KEYS key or a key created via `/api-keys`;
 *  - `Authorization: Bearer <access token>` (SHIM_ACCESS_TOKENS), E2B's
 *    account access token, required by `/teams` and `/api-keys`;
 *  - `X-Admin-Token` or `Authorization: Bearer <admin token>`
 *    (SHIM_ADMIN_TOKEN), E2B's admin credentials.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { ShimConfig } from "./config.js";
import type { ApiKeyMask, ShimStore } from "./store.js";

export type PrincipalKind = "apiKey" | "accessToken" | "admin";

export interface Principal {
  kind: PrincipalKind;
  /** Managed API key ID when authenticated with a key created via /api-keys. */
  apiKeyId?: string;
}

export type AuthResult = { principal: Principal } | { status: number; message: string };

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function header(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  const first = Array.isArray(value) ? value[0] : value;
  return first ? first.trim() : null;
}

function parseKey(raw: string): Buffer {
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (hex.length !== 32) throw new Error("SHIM_ENCRYPTION_KEY must be 32 bytes (hex or base64)");
  return hex;
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export class Platform {
  readonly teamId: string;
  readonly teamName: string;
  private readonly key: Buffer;

  constructor(
    private readonly config: ShimConfig,
    private readonly store: ShimStore
  ) {
    this.teamId = config.teamId || store.ensureSetting("team_id", () => randomUUID());
    this.teamName = config.teamName;
    this.key = config.encryptionKey
      ? parseKey(config.encryptionKey)
      : Buffer.from(
          store.ensureSetting("encryption_key", () => randomBytes(32).toString("base64")),
          "base64"
        );
  }

  // -------------------------------------------------------------------------
  // Encryption at rest (AES-256-GCM) and keyed MACs
  // -------------------------------------------------------------------------

  encrypt(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(
      ":"
    );
  }

  decrypt(sealed: string): string {
    const [version, iv, tag, data] = sealed.split(":");
    if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("unsupported ciphertext");
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
  }

  /** Domain-separated HMAC over `data`, base64url. */
  mac(purpose: string, data: string): string {
    return createHmac("sha256", this.key).update(`${purpose}\0${data}`).digest("base64url");
  }

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  authenticate(req: IncomingMessage): AuthResult {
    const teamHeader = header(req, "x-team-id");
    if (teamHeader && teamHeader !== this.teamId) {
      return { status: 403, message: `Team ${teamHeader} is not served by this deployment` };
    }

    const adminHeader = header(req, "x-admin-token");
    if (adminHeader !== null) {
      if (this.config.adminToken && safeEqual(adminHeader, this.config.adminToken)) {
        return { principal: { kind: "admin" } };
      }
      return { status: 401, message: "Invalid admin token" };
    }

    const authorization = header(req, "authorization");
    if (authorization && /^bearer\s+/i.test(authorization)) {
      const token = authorization.replace(/^bearer\s+/i, "");
      if (this.config.adminToken && safeEqual(token, this.config.adminToken)) {
        return { principal: { kind: "admin" } };
      }
      if (this.config.accessTokens.some((candidate) => safeEqual(token, candidate))) {
        return { principal: { kind: "accessToken" } };
      }
      return { status: 401, message: "Invalid access token" };
    }

    const apiKey = header(req, "x-api-key");
    if (apiKey) {
      if (this.config.apiKeys.some((candidate) => safeEqual(apiKey, candidate))) {
        return { principal: { kind: "apiKey" } };
      }
      const managed = this.store.findApiKeyByHash(hashApiKey(apiKey));
      if (managed) {
        this.store.touchApiKey(managed);
        return { principal: { kind: "apiKey", apiKeyId: managed } };
      }
      return { status: 401, message: "Invalid API key" };
    }

    return { status: 401, message: "Missing authentication: provide 'X-API-Key: <key>'" };
  }

  // -------------------------------------------------------------------------
  // Managed API keys (E2B `e2b_` + 40 hex format)
  // -------------------------------------------------------------------------

  mintApiKey(name: string): { id: string; key: string; mask: ApiKeyMask; createdAt: string } {
    const secret = randomBytes(20).toString("hex");
    const key = `e2b_${secret}`;
    const mask: ApiKeyMask = {
      prefix: "e2b_",
      valueLength: secret.length,
      maskedValuePrefix: secret.slice(0, 2),
      maskedValueSuffix: secret.slice(-4),
    };
    const created = { id: randomUUID(), key, mask, createdAt: new Date().toISOString() };
    this.store.createApiKey({
      id: created.id,
      name,
      mask,
      createdAt: created.createdAt,
      lastUsed: null,
      keyHash: hashApiKey(key),
    });
    return created;
  }
}
