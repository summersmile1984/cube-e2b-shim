import { describe, expect, it, vi } from "vitest";
import { runE2BSmoke, type E2BSmokeConfig } from "./smoke";

const config: E2BSmokeConfig = {
  apiUrl: "https://cubeapi.example.test",
  apiKey: "client-key",
  templateId: "tpl-ready",
  expectedDomain: "sb.example.test",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("runE2BSmoke", () => {
  it("checks the shim contract and always deletes the created sandbox", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templateID: "tpl-ready", status: "READY" }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            sandboxID: "sb-smoke",
            templateID: "tpl-ready",
            domain: "sb.example.test",
            envdAccessToken: "envd-token",
          },
          201
        )
      )
      .mockResolvedValueOnce(
        jsonResponse({
          sandboxID: "sb-smoke",
          templateID: "tpl-ready",
          state: "running",
          domain: "sb.example.test",
          metadata: { "cube-e2b-shim.e2e": "true" },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(runE2BSmoke(config, { fetch: fetchMock })).resolves.toEqual({
      sandboxID: "sb-smoke",
      templateID: "tpl-ready",
      domain: "sb.example.test",
      state: "running",
      envdAccessTokenPresent: true,
      cleanedUp: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://cubeapi.example.test/templates/tpl-ready");
    const createBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(createBody).toMatchObject({
      templateID: "tpl-ready",
      secure: true,
      envVars: { OI_E2E_SENTINEL: "cube-e2b-shim-e2e-ok" },
      metadata: { "cube-e2b-shim.e2e": "true" },
    });
    expect(fetchMock.mock.calls[3]?.[1]?.method).toBe("DELETE");
  });

  it("fails before create when the configured template is not ready", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templateID: "tpl-ready", status: "FAILED" }));

    await expect(runE2BSmoke(config, { fetch: fetchMock })).rejects.toThrow(
      "expected READY, got FAILED"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("detects a direct Cube API that ignores secure mode and still cleans up", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ templateID: "tpl-ready", status: "READY" }))
      .mockResolvedValueOnce(
        jsonResponse(
          { sandboxID: "sb-direct-cube", templateID: "tpl-ready", domain: "cube.app" },
          201
        )
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(runE2BSmoke(config, { fetch: fetchMock })).rejects.toThrow(
      "missing envdAccessToken"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]?.method).toBe("DELETE");
  });
});
