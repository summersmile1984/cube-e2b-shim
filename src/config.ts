/**
 * Shim configuration from environment variables.
 *
 * The shim terminates its own API keys (SHIM_API_KEYS) and forwards to the
 * CubeSandbox CubeAPI with the single backend key (CUBE_API_KEY), so callers
 * never hold the backend credential.
 */

import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface ShimConfig {
  /** Port the shim listens on (API surface and edge surface share it, split by Host). */
  listenPort: number;
  /**
   * Optional bind address. Empty/undefined keeps Node's default (all
   * interfaces); production deployments set this to the private address that
   * the gateway host is allowed to reach.
   */
  listenHost?: string;
  /** Optional TLS material to enable an HTTPS listener (overrides plain HTTP when set). */
  tlsKey?: string;
  tlsCert?: string;
  /** API keys accepted on the E2B-facing surface. */
  apiKeys: string[];
  /** CubeAPI base URL, e.g. http://127.0.0.1:3000. */
  cubeApiUrl: string;
  /** Backend CubeAPI key injected on forwarded requests. */
  cubeApiKey: string;
  /**
   * Public domain the shim advertises in sandbox responses (`domain` field) and
   * serves on the edge surface, e.g. `sb.example.org`. Empty keeps Cube's domain.
   */
  shimDomain: string;
  /** CubeProxy base URL used by the edge surface, e.g. http://192.168.9.100. */
  cubeProxyUrl: string;
  /** Cube's internal sandbox domain (the Host cube-proxy routes on), e.g. cube.app. */
  cubeDomain: string;
  /**
   * SQLite file path for shim state (SHIM_DB_PATH, required). ":memory:" is
   * accepted only when set explicitly; it loses every envd token on restart.
   */
  dbPath: string;
  /** Strip Cube-internal (`cube.*`, `X-Caller`) metadata keys from list/get responses. */
  stripCubeMetadata: boolean;
  /**
   * Directory for E2B template COPY archives (SHIM_BUILD_FILES_DIR). Defaults
   * to `template-files` next to the SQLite file, or the OS temp dir for
   * `:memory:`.
   */
  buildFilesDir: string;
  /** Writable layer size for Cube templates built from `fromImage` (SHIM_TEMPLATE_DISK_SIZE). */
  templateDiskSize: string;
  /**
   * Public origin of the API surface used in template file upload URLs
   * (SHIM_PUBLIC_API_URL, e.g. https://api.example.com). When empty the
   * origin is derived from the request's Host / X-Forwarded-Proto.
   */
  publicApiUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShimConfig {
  const apiKeys = (env.SHIM_API_KEYS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  if (apiKeys.length === 0) {
    throw new ConfigError("SHIM_API_KEYS must list at least one API key (comma-separated)");
  }
  const cubeApiKey = env.CUBE_API_KEY ?? "";
  if (!cubeApiKey) {
    throw new ConfigError("CUBE_API_KEY is required (backend CubeAPI credential)");
  }
  // The store holds every issued envd token. An implicit in-memory default
  // made each restart lock clients out of their running sandboxes (envd 401),
  // so a volatile store must now be requested explicitly.
  const dbPath = (env.SHIM_DB_PATH ?? "").trim();
  if (!dbPath) {
    throw new ConfigError(
      "SHIM_DB_PATH is required: point it at a durable SQLite file (envd tokens live there), " +
        "or set it to :memory: explicitly for throwaway development"
    );
  }
  return {
    listenPort: Number.parseInt(env.SHIM_LISTEN_PORT ?? "3100", 10),
    listenHost: (env.SHIM_LISTEN_HOST ?? "").trim() || undefined,
    apiKeys,
    tlsKey: env.SHIM_TLS_KEY ?? "",
    tlsCert: env.SHIM_TLS_CERT ?? "",
    cubeApiUrl: (env.CUBE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    cubeApiKey,
    shimDomain: env.SHIM_DOMAIN ?? "",
    cubeProxyUrl: (env.CUBE_PROXY_URL ?? "http://192.168.9.100").replace(/\/+$/, ""),
    cubeDomain: env.CUBE_DOMAIN ?? "cube.app",
    dbPath,
    stripCubeMetadata: env.SHIM_STRIP_CUBE_METADATA !== "false",
    buildFilesDir:
      (env.SHIM_BUILD_FILES_DIR ?? "").trim() ||
      (dbPath === ":memory:"
        ? join(tmpdir(), "cube-e2b-shim-template-files")
        : join(dirname(dbPath), "template-files")),
    templateDiskSize: (env.SHIM_TEMPLATE_DISK_SIZE ?? "").trim() || "4G",
    publicApiUrl: (env.SHIM_PUBLIC_API_URL ?? "").trim().replace(/\/+$/, ""),
  };
}
