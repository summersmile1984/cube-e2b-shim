import { pathToFileURL } from "node:url";

const REQUEST_TIMEOUT_MS = 90_000;
const SMOKE_MARKER = "cube-e2b-shim-e2e-ok";

export interface E2BSmokeConfig {
  apiUrl: string;
  apiKey: string;
  templateId: string;
  expectedDomain?: string;
}

export interface E2BSmokeResult {
  sandboxID: string;
  templateID: string;
  domain: string;
  state: string;
  envdAccessTokenPresent: true;
  cleanedUp: true;
}

export interface E2BSmokeDependencies {
  fetch: typeof fetch;
}

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

export function loadSmokeConfig(env: NodeJS.ProcessEnv = process.env): E2BSmokeConfig {
  return {
    apiUrl: required("E2B_API_URL", env.E2B_API_URL).replace(/\/+$/, ""),
    apiKey: required("E2B_API_KEY", env.E2B_API_KEY),
    templateId: required("E2B_TEMPLATE_ID", env.E2B_TEMPLATE_ID),
    expectedDomain: env.E2B_EXPECTED_DOMAIN?.trim() || undefined,
  };
}

function headers(config: E2BSmokeConfig, json = false): Record<string, string> {
  return {
    "X-API-Key": config.apiKey,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

async function request(
  fetchImpl: typeof fetch,
  config: E2BSmokeConfig,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const response = await fetchImpl(`${config.apiUrl}${path}`, {
    ...init,
    headers: { ...headers(config, init.body !== undefined), ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  return response;
}

async function json<T>(response: Response, operation: string): Promise<T> {
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text) as { message?: unknown };
      if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // Keep the raw provider message when the response is not JSON.
    }
    throw new Error(`${operation} failed with HTTP ${response.status}: ${detail}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function record(value: unknown, operation: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${operation} returned an invalid object`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, field: string, operation: string): string {
  const result = value[field];
  if (typeof result !== "string" || !result) {
    throw new Error(`${operation} response is missing ${field}`);
  }
  return result;
}

export async function runE2BSmoke(
  config: E2BSmokeConfig,
  dependencies: E2BSmokeDependencies = { fetch }
): Promise<E2BSmokeResult> {
  const template = record(
    await json<unknown>(
      await request(
        dependencies.fetch,
        config,
        `/templates/${encodeURIComponent(config.templateId)}`
      ),
      "template preflight"
    ),
    "template preflight"
  );
  if (template.status !== "READY") {
    throw new Error(`template preflight expected READY, got ${String(template.status)}`);
  }

  let sandboxID: string | undefined;
  let result: Omit<E2BSmokeResult, "cleanedUp"> | undefined;
  let primaryError: unknown;
  try {
    const created = record(
      await json<unknown>(
        await request(dependencies.fetch, config, "/sandboxes", {
          method: "POST",
          body: JSON.stringify({
            templateID: config.templateId,
            timeout: 300,
            secure: true,
            envVars: { OI_E2E_SENTINEL: SMOKE_MARKER },
            metadata: { "cube-e2b-shim.e2e": "true" },
          }),
        }),
        "sandbox create"
      ),
      "sandbox create"
    );
    sandboxID = stringField(created, "sandboxID", "sandbox create");
    const envdAccessToken = stringField(created, "envdAccessToken", "sandbox create");
    if (!envdAccessToken) throw new Error("sandbox create did not return envdAccessToken");
    const domain = stringField(created, "domain", "sandbox create");
    if (config.expectedDomain && domain !== config.expectedDomain) {
      throw new Error(`sandbox create expected domain ${config.expectedDomain}, got ${domain}`);
    }

    const detail = record(
      await json<unknown>(
        await request(dependencies.fetch, config, `/sandboxes/${encodeURIComponent(sandboxID)}`),
        "sandbox get"
      ),
      "sandbox get"
    );
    const state = stringField(detail, "state", "sandbox get");
    if (state !== "running") throw new Error(`sandbox get expected running, got ${state}`);
    const metadata = record(detail.metadata, "sandbox get metadata");
    if (metadata["cube-e2b-shim.e2e"] !== "true") {
      throw new Error("sandbox get did not preserve the E2E metadata marker");
    }

    result = {
      sandboxID,
      templateID: config.templateId,
      domain,
      state,
      envdAccessTokenPresent: true,
    };
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: Error | undefined;
  if (sandboxID) {
    try {
      const response = await request(
        dependencies.fetch,
        config,
        `/sandboxes/${encodeURIComponent(sandboxID)}`,
        { method: "DELETE" }
      );
      if (!response.ok && response.status !== 404) {
        cleanupError = new Error(`sandbox cleanup failed with HTTP ${response.status}`);
      }
    } catch (error) {
      cleanupError = error instanceof Error ? error : new Error("sandbox cleanup failed");
    }
  }

  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  if (!result) throw new Error("sandbox smoke did not produce a result");
  return { ...result, cleanedUp: true };
}

async function main(): Promise<void> {
  const result = await runE2BSmoke(loadSmokeConfig());
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown E2B smoke failure";
    process.stderr.write(`E2B smoke failed: ${message}\n`);
    process.exitCode = 1;
  });
}
