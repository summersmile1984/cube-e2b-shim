/**
 * Shim configuration from environment variables.
 *
 * The shim terminates its own API keys (SHIM_API_KEYS) and forwards to the
 * CubeSandbox CubeAPI with the single backend key (CUBE_API_KEY), so callers
 * never hold the backend credential.
 */

export interface ShimConfig {
  /** Port the shim listens on (API surface and edge surface share it, split by Host). */
  listenPort: number;
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
  /** SQLite file path for shim state (":memory:" supported). */
  dbPath: string;
  /** Strip Cube-internal (`cube.*`, `X-Caller`) metadata keys from list/get responses. */
  stripCubeMetadata: boolean;
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
  return {
    listenPort: Number.parseInt(env.SHIM_LISTEN_PORT ?? "3100", 10),
    apiKeys,
    tlsKey: env.SHIM_TLS_KEY ?? "",
    tlsCert: env.SHIM_TLS_CERT ?? "",
    cubeApiUrl: (env.CUBE_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
    cubeApiKey,
    shimDomain: env.SHIM_DOMAIN ?? "",
    cubeProxyUrl: (env.CUBE_PROXY_URL ?? "http://192.168.9.100").replace(/\/+$/, ""),
    cubeDomain: env.CUBE_DOMAIN ?? "cube.app",
    dbPath: env.SHIM_DB_PATH ?? ":memory:",
    stripCubeMetadata: env.SHIM_STRIP_CUBE_METADATA !== "false",
  };
}
