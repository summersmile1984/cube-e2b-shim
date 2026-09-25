/**
 * envd access tokens and E2B presigned file URL signatures.
 */

import { randomBytes, createHash } from "node:crypto";

/** Generate an envd access token with the same shape managed E2B uses. */
export function generateEnvdToken(): string {
  return "v1_" + randomBytes(32).toString("base64url");
}

/**
 * E2B's presigned file URL signature: unpadded base64 of
 * SHA256("path:read|write:user:token[:expirationUnix]"), prefixed `v1_`.
 * The edge surface verifies these against the stored token.
 */
export function fileSignature(
  path: string,
  op: "read" | "write",
  user: string,
  token: string,
  expiration?: number
): string {
  const base = `${path}:${op}:${user}:${token}`;
  const payload = expiration !== undefined ? `${base}:${expiration}` : base;
  return "v1_" + createHash("sha256").update(payload).digest("base64").replace(/=+$/, "");
}
