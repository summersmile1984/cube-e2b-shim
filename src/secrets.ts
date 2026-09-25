/**
 * E2B secrets on Cube.
 *
 * E2B stores secrets server-side and lets network egress rules reference
 * them as `${e2b.secrets.<name>}` inside `transform.headers` values; the
 * platform substitutes the value outside the sandbox, so it never enters the
 * VM. Cube's egress applies header transforms but knows nothing about E2B
 * secrets, so the shim substitutes the values when it forwards a network
 * config to Cube, and keeps the placeholder form to report back to callers.
 */

import { ShimHttpError } from "./http-util.js";
import type { Platform } from "./platform.js";
import type { ShimStore } from "./store.js";

const PLACEHOLDER = /\$\{e2b\.secrets\.([^}]*)\}/g;

export const SECRET_NAME_RE = /^[a-zA-Z0-9_-]{1,128}$/;

export function validateSecretMetadata(metadata: unknown): Record<string, string> {
  if (metadata === undefined || metadata === null) return {};
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ShimHttpError(400, "metadata must be an object of strings");
  }
  const entries = Object.entries(metadata as Record<string, unknown>);
  if (entries.length > 32) throw new ShimHttpError(400, "metadata allows at most 32 entries");
  let total = 0;
  for (const [key, value] of entries) {
    if (typeof value !== "string") throw new ShimHttpError(400, `metadata ${key} must be a string`);
    const keyBytes = Buffer.byteLength(key);
    const valueBytes = Buffer.byteLength(value);
    if (keyBytes > 128) throw new ShimHttpError(400, "metadata keys are limited to 128 bytes");
    if (valueBytes > 1024) throw new ShimHttpError(400, "metadata values are limited to 1024 bytes");
    total += keyBytes + valueBytes;
  }
  if (total > 8192) throw new ShimHttpError(400, "metadata is limited to 8192 bytes in total");
  return Object.fromEntries(entries) as Record<string, string>;
}

/**
 * Return a copy of an E2B network config with every secret placeholder in
 * `rules[*][*].transform.headers` replaced by its value. Unknown secrets are
 * a 400, as nothing could resolve them later.
 */
export function resolveNetworkSecrets(network: unknown, store: ShimStore, platform: Platform): unknown {
  if (network === null || typeof network !== "object" || Array.isArray(network)) return network;
  const rules = (network as { rules?: unknown }).rules;
  if (rules === null || typeof rules !== "object" || Array.isArray(rules)) return network;

  const resolvedRules: Record<string, unknown> = {};
  for (const [host, list] of Object.entries(rules as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      resolvedRules[host] = list;
      continue;
    }
    resolvedRules[host] = list.map((rule: unknown) => {
      const headers = (rule as { transform?: { headers?: unknown } } | null)?.transform?.headers;
      if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return rule;
      const resolvedHeaders = Object.fromEntries(
        Object.entries(headers as Record<string, unknown>).map(([name, value]) => [
          name,
          typeof value === "string"
            ? value.replace(PLACEHOLDER, (_match, secretName: string) => {
                const sealed = store.getSecretValue(secretName);
                if (sealed === null) {
                  throw new ShimHttpError(400, `secret ${JSON.stringify(secretName)} not found`);
                }
                return platform.decrypt(sealed);
              })
            : value,
        ])
      );
      const typedRule = rule as { transform: Record<string, unknown> };
      return { ...typedRule, transform: { ...typedRule.transform, headers: resolvedHeaders } };
    });
  }
  return { ...(network as Record<string, unknown>), rules: resolvedRules };
}
