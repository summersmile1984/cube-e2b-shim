/**
 * Thin typed client for the CubeSandbox CubeAPI (E2B-compatible surface).
 *
 * The shim never exposes CUBE_API_KEY to callers; every forwarded request
 * injects it here. Errors preserve the upstream status code and body so the
 * shim can relay Cube's (already E2B-shaped) error payloads unchanged.
 */

export class CubeApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "CubeApiError";
  }
}

export interface CubeResponse {
  status: number;
  /** Raw body text; empty for 204 responses. */
  body: string;
  contentType: string;
  /** Response headers needed for E2B pagination passthrough. */
  headers: Headers;
}

export class CubeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string
  ) {}

  async request(
    method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
    path: string,
    body?: unknown
  ): Promise<CubeResponse> {
    const init: RequestInit = {
      method,
      headers: {
        "X-API-Key": this.apiKey,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
    };
    if (body !== undefined) init.body = JSON.stringify(body);
    const response = await fetch(`${this.baseUrl}${path}`, init);
    return {
      status: response.status,
      body: await response.text(),
      contentType: response.headers.get("content-type") ?? "",
      headers: response.headers,
    };
  }

  async requestJson<T>(
    method: "GET" | "POST" | "DELETE" | "PATCH" | "PUT",
    path: string,
    body?: unknown
  ): Promise<{ status: number; data: T }> {
    const response = await this.request(method, path, body);
    if (response.status >= 400) {
      throw new CubeApiError(
        response.body || `Cube ${method} ${path} failed`,
        response.status,
        response.body
      );
    }
    return { status: response.status, data: JSON.parse(response.body) as T };
  }
}
