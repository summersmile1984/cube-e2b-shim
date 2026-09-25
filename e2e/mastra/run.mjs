/**
 * End-to-end check of a deployed cube-e2b-shim, driven by the official E2B
 * SDK and Mastra's E2BSandbox, the way a Mastra application uses it.
 *
 *   E2B_API_KEY=<a SHIM_API_KEYS value>
 *   E2B_DOMAIN=example.com            (SHIM_DOMAIN; E2B_API_URL / E2B_SANDBOX_URL
 *                                      override the derived endpoints)
 *   E2E_TEMPLATE=<Cube template ID or alias to run sandboxes from>
 *   E2E_BUILD_BASE=base               (fromTemplate base for the build test;
 *                                      set E2E_SKIP_BUILD=1 to skip it)
 *
 * Every sandbox and template it creates is deleted at the end. Exit code is
 * non-zero when any check fails.
 */

import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sandbox, Template } from "e2b";
import { E2BSandbox } from "@mastra/e2b";

const env = process.env;
const template = env.E2E_TEMPLATE;
if (!env.E2B_API_KEY || !template || !env.E2B_DOMAIN) {
  console.error("Set E2B_API_KEY, E2E_TEMPLATE and E2B_DOMAIN (optionally E2B_API_URL/E2B_SANDBOX_URL).");
  process.exit(2);
}
const apiUrl = env.E2B_API_URL || `https://api.${env.E2B_DOMAIN}`;
const opts = { requestTimeoutMs: 120_000 };
const runId = randomBytes(4).toString("hex");

let failures = 0;
function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!condition) failures++;
}
async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * GET `path` on a sandbox's envd through its per-sandbox hostname
 * (`49983-<id>.<domain>`), which is what signed file URLs and browsers use.
 * With E2B_SANDBOX_URL set (single gateway, no wildcard DNS) the request is
 * sent to that origin with the per-sandbox hostname in the Host header, which
 * is what the shim's edge routes on.
 */
function sandboxGet(sandboxId, path, headers = {}) {
  const host = `49983-${sandboxId}.${env.E2B_DOMAIN}`;
  const target = new URL(path, `https://${host}`);
  const gateway = env.E2B_SANDBOX_URL ? new URL(env.E2B_SANDBOX_URL) : target;
  const client = gateway.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      {
        hostname: gateway.hostname,
        port: gateway.port || (gateway.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        headers: { ...headers, Host: host },
        servername: target.hostname,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", reject);
    req.end();
  });
}

const cleanup = [];

// ---------------------------------------------------------------------------
// 1. Official E2B SDK against the shim
// ---------------------------------------------------------------------------
await step("E2B SDK sandbox lifecycle", async () => {
  const marker = `shim-e2e-${runId}`;
  const sbx = await Sandbox.create(template, {
    ...opts,
    timeoutMs: 300_000,
    envs: { SHIM_E2E: marker, SHIM_E2E_LARGE: "x".repeat(6000) },
    metadata: { "shim-e2e": runId },
  });
  cleanup.push(() => sbx.kill());
  const detail = await (
    await fetch(`${apiUrl}/sandboxes/${sbx.sandboxId}`, { headers: { "X-API-Key": env.E2B_API_KEY } })
  ).json();
  check("create (POST /v2/sandboxes) secured the sandbox", /^v1_/.test(detail.envdAccessToken ?? ""));

  const run = await sbx.commands.run('echo "$SHIM_E2E ${#SHIM_E2E_LARGE}"');
  check("commands.run sees create-time env vars", run.stdout.trim() === `${marker} 6000`, run.stdout.trim());

  await sbx.files.write("/tmp/shim-e2e.txt", marker);
  check("files.write + files.read", (await sbx.files.read("/tmp/shim-e2e.txt")) === marker);

  // Signed URLs carry no sandbox ID; like on E2B they are served from the
  // per-sandbox hostname, so they need wildcard DNS for SHIM_DOMAIN.
  const signed = new URL(await sbx.downloadUrl("/tmp/shim-e2e.txt", { useSignatureExpiration: 120 }));
  const download = await sandboxGet(sbx.sandboxId, signed.pathname + signed.search);
  check("signed download URL", download.status === 200 && download.body === marker, `HTTP ${download.status}`);

  signed.searchParams.set("signature", "v1_forged");
  const forged = await sandboxGet(sbx.sandboxId, signed.pathname + signed.search);
  check("forged signature is refused", forged.status === 401, `HTTP ${forged.status}`);

  const anonymous = await sandboxGet(sbx.sandboxId, "/envs");
  check("envd refuses requests without the access token", anonymous.status === 401, `HTTP ${anonymous.status}`);
  const authorized = await sandboxGet(sbx.sandboxId, "/envs", { "X-Access-Token": detail.envdAccessToken });
  check("envd accepts the access token", authorized.status === 200, `HTTP ${authorized.status}`);

  const listed = await Sandbox.list({ ...opts, query: { metadata: { "shim-e2e": runId } } }).nextItems();
  check("list filters by metadata", listed.some((s) => s.sandboxId === sbx.sandboxId), `${listed.length} found`);

  await sbx.pause();
  const resumed = await Sandbox.connect(sbx.sandboxId, opts);
  check(
    "pause + connect (POST /v2/sandboxes/{id}/connect) keeps state",
    (await resumed.files.read("/tmp/shim-e2e.txt")) === marker
  );

  const metrics = await resumed.getMetrics().catch(() => null);
  check("metrics endpoint answers", Array.isArray(metrics), metrics ? `${metrics.length} points` : "error");
});

// ---------------------------------------------------------------------------
// 2. E2B Template.build() executed on Cube
// ---------------------------------------------------------------------------
let builtTemplate = null;
if (!env.E2E_SKIP_BUILD) {
  await step("Template.build on Cube", async () => {
    const context = mkdtempSync(join(tmpdir(), "shim-e2e-ctx-"));
    writeFileSync(join(context, "hello.txt"), `copied-${runId}`);
    const name = `shim-e2e-${runId}`;
    const definition = Template({ fileContextPath: context })
      .fromTemplate(env.E2E_BUILD_BASE || "base")
      .runCmd("mkdir -p /opt/shim-e2e && echo built > /opt/shim-e2e/run.txt", { user: "root" })
      .setEnvs({ SHIM_E2E_BUILD: runId })
      .setWorkdir("/opt/shim-e2e")
      .copy("hello.txt", "/opt/shim-e2e/hello.txt");
    const started = Date.now();
    await Template.build(definition, name, { ...opts, onBuildLogs: (entry) => console.log(`      build: ${entry.message}`) });
    cleanup.push(() =>
      fetch(`${apiUrl}/templates/${name}`, { method: "DELETE", headers: { "X-API-Key": env.E2B_API_KEY } })
    );
    check("Template.build finished", true, `${Math.round((Date.now() - started) / 1000)} s`);
    check("Template.exists(name)", await Template.exists(name, opts));
    builtTemplate = name;

    const sbx = await Sandbox.create(name, { ...opts, timeoutMs: 120_000 });
    cleanup.unshift(() => sbx.kill());
    const out = await sbx.commands.run("pwd; echo $SHIM_E2E_BUILD; cat run.txt hello.txt");
    check(
      "sandbox from the built template has workdir, env and files",
      out.stdout.trim() === `/opt/shim-e2e\n${runId}\nbuilt\ncopied-${runId}`,
      JSON.stringify(out.stdout.trim())
    );
  });
}

// ---------------------------------------------------------------------------
// 3. Mastra's E2BSandbox
// ---------------------------------------------------------------------------
await step("Mastra E2BSandbox", async () => {
  const sandbox = new E2BSandbox({
    id: `shim-e2e-mastra-${runId}`,
    template: builtTemplate ?? template,
    timeout: 300_000,
    env: { MASTRA_E2E: runId },
    lifecycle: { onTimeout: "kill" },
    apiKey: env.E2B_API_KEY,
    ...(env.E2B_DOMAIN ? { domain: env.E2B_DOMAIN } : {}),
    ...(env.E2B_API_URL ? { apiUrl: env.E2B_API_URL } : {}),
  });
  cleanup.unshift(() => sandbox.destroy());

  await sandbox.ensureRunning();
  check("Mastra start() created a sandbox", Boolean(sandbox.sandboxId), sandbox.sandboxId);

  const echo = await sandbox.executeCommand("sh", ["-c", "echo mastra-$MASTRA_E2E"]);
  check("Mastra executeCommand", echo.stdout?.trim() === `mastra-${runId}`, JSON.stringify(echo.stdout?.trim()));

  await sandbox.writeFiles([{ path: "/tmp/mastra-e2e.txt", content: runId }]);
  const cat = await sandbox.executeCommand("cat", ["/tmp/mastra-e2e.txt"]);
  check("Mastra writeFiles", cat.stdout?.trim() === runId);

  const info = await sandbox.getInfo();
  check("Mastra getInfo", info.status === "running" || Boolean(info.id), `status ${info.status}`);

  // _stop()/_start() are the managed lifecycle wrappers Workspace uses.
  await sandbox._stop();
  await sandbox.ensureRunning();
  const again = await sandbox.executeCommand("cat", ["/tmp/mastra-e2e.txt"]);
  check("Mastra stop() pauses and start() resumes with state", again.stdout?.trim() === runId);
});

// ---------------------------------------------------------------------------
for (const fn of cleanup) {
  await Promise.resolve()
    .then(fn)
    .catch((error) => console.log(`WARN  cleanup: ${error instanceof Error ? error.message : error}`));
}
console.log(failures === 0 ? "\nALL CHECKS PASSED" : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
