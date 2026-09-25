/**
 * E2B sandbox lifecycle events, team metrics and webhook delivery.
 *
 * Events come from two places:
 *  - the shim's own API calls (create, kill, pause, resume, timeout, network,
 *    snapshot), recorded as they succeed;
 *  - a poller that diffs Cube's sandbox list against the last observed state,
 *    catching what Cube does on its own (TTL kills, auto-pause, auto-resume)
 *    and sandboxes created outside the shim.
 *
 * Each poll also samples the team's concurrent sandboxes and start rate for
 * `/teams/{id}/metrics`. Events fan out to registered webhooks with E2B's
 * `e2b-signature` (base64 SHA-256 of secret + body, padding stripped).
 */

import { createHash, randomUUID } from "node:crypto";
import type { CubeClient } from "./cube-client.js";
import type { ShimConfig } from "./config.js";
import type { Platform } from "./platform.js";
import type { SandboxEventRow, ShimStore, WebhookDeliveryRow, WebhookRow } from "./store.js";

export const SANDBOX_EVENT_TYPES = [
  "sandbox.lifecycle.created",
  "sandbox.lifecycle.killed",
  "sandbox.lifecycle.paused",
  "sandbox.lifecycle.resumed",
  "sandbox.lifecycle.updated",
  "sandbox.lifecycle.checkpointed",
] as const;
export type SandboxEventType = (typeof SANDBOX_EVENT_TYPES)[number];

/** Metadata prefix marking the shim's own private sandboxes (builds, volume helpers). */
export const INTERNAL_METADATA_PREFIX = "cube-e2b-shim.";

export function isInternalSandbox(sandbox: { metadata?: Record<string, unknown> | null }): boolean {
  return Object.keys(sandbox.metadata ?? {}).some((key) => key.startsWith(INTERNAL_METADATA_PREFIX));
}

const WEBHOOK_RETRY_DELAYS_MS = [0, 5_000, 30_000];
const WEBHOOK_TIMEOUT_MS = 10_000;
const MAX_STORED_BODY = 4_096;

export interface EventSubject {
  sandboxId: string;
  templateId?: string;
}

interface CubeListedSandbox {
  sandboxID: string;
  templateID?: string;
  state?: string;
  clientID?: string;
  metadata?: Record<string, string>;
}

/** Resolve Cube template IDs of shim-built templates to their E2B name and build. */
export function templateDescriber(store: ShimStore): (cubeTemplateId: string) => { templateId: string; buildId: string } | null {
  return (cubeTemplateId) => {
    const named = store.findTemplateByCubeId(cubeTemplateId);
    return named ? { templateId: named.name, buildId: named.buildId } : null;
  };
}

/** E2B webhook signature: unpadded base64 of SHA-256(secret + raw body). */
export function webhookSignature(secret: string, body: string): string {
  return createHash("sha256").update(secret + body).digest("base64").replace(/=+$/, "");
}

export class EventHub {
  private timer: NodeJS.Timeout | null = null;
  private lastSampleMs = Date.now();
  private readonly pending = new Set<Promise<void>>();
  /** Test hook: overrides the webhook retry schedule. */
  retryDelaysMs = WEBHOOK_RETRY_DELAYS_MS;

  constructor(
    private readonly config: ShimConfig,
    private readonly store: ShimStore,
    private readonly cube: CubeClient,
    private readonly platform: Platform,
    /** Maps a Cube template ID to the E2B template/build it serves, when known. */
    private readonly describeTemplate: (cubeTemplateId: string) => { templateId: string; buildId: string } | null =
      () => null
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll().catch(() => undefined), this.config.eventPollSeconds * 1000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Wait for in-flight webhook deliveries (tests and shutdown). */
  async drain(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // -------------------------------------------------------------------------
  // Recording
  // -------------------------------------------------------------------------

  /** Record a lifecycle event the shim observed or caused. */
  record(type: SandboxEventType, subject: EventSubject, data?: Record<string, unknown>): SandboxEventRow {
    const observed = this.store.getObserved(subject.sandboxId);
    const cubeTemplateId = subject.templateId ?? observed?.templateId ?? "";
    let executionId = observed?.executionId ?? randomUUID();
    if (type === "sandbox.lifecycle.created" || type === "sandbox.lifecycle.resumed") executionId = randomUUID();

    const described = cubeTemplateId ? this.describeTemplate(cubeTemplateId) : null;
    const event: SandboxEventRow = {
      id: randomUUID(),
      sandboxId: subject.sandboxId,
      type,
      timestamp: new Date().toISOString(),
      executionId,
      templateId: described?.templateId ?? cubeTemplateId,
      buildId: described?.buildId ?? cubeTemplateId,
      data: data ?? null,
    };
    this.store.insertEvent(event);

    if (type === "sandbox.lifecycle.killed") {
      this.store.removeObserved(subject.sandboxId);
    } else {
      const state =
        type === "sandbox.lifecycle.paused"
          ? "paused"
          : type === "sandbox.lifecycle.created" || type === "sandbox.lifecycle.resumed"
            ? "running"
            : (observed?.state ?? "running");
      this.store.upsertObserved({
        sandboxId: subject.sandboxId,
        state,
        templateId: cubeTemplateId,
        executionId,
        clientId: observed?.clientId ?? null,
      });
    }

    this.dispatch(event);
    return event;
  }

  /** E2B's SandboxEvent (API shape). */
  toApi(event: SandboxEventRow): Record<string, unknown> {
    return {
      id: event.id,
      version: "v2",
      type: event.type,
      eventCategory: "lifecycle",
      eventLabel: event.type.split(".").pop(),
      eventData: event.data,
      timestamp: event.timestamp,
      sandboxId: event.sandboxId,
      sandboxExecutionId: event.executionId,
      sandboxTemplateId: event.templateId,
      sandboxBuildId: event.buildId,
      sandboxTeamId: this.platform.teamId,
    };
  }

  /** Webhook payload: E2B's event-bus shape (snake_case). */
  toWebhookPayload(event: SandboxEventRow): Record<string, unknown> {
    return {
      id: event.id,
      version: "v2",
      type: event.type,
      event_category: "lifecycle",
      event_label: event.type.split(".").pop(),
      event_data: event.data,
      sandbox_id: event.sandboxId,
      sandbox_execution_id: event.executionId,
      sandbox_template_id: event.templateId,
      sandbox_build_id: event.buildId,
      sandbox_team_id: this.platform.teamId,
      timestamp: event.timestamp,
    };
  }

  // -------------------------------------------------------------------------
  // Polling Cube
  // -------------------------------------------------------------------------

  /** Diff Cube's sandbox list against observed state and sample team metrics. */
  async poll(): Promise<void> {
    const { data } = await this.cube.requestJson<CubeListedSandbox[]>("GET", "/v2/sandboxes?limit=2147483647");
    const live = data.filter((sandbox) => !isInternalSandbox(sandbox));
    const baseline = this.store.getSetting("events_baseline") === null;
    const seen = new Set<string>();

    for (const sandbox of live) {
      seen.add(sandbox.sandboxID);
      const observed = this.store.getObserved(sandbox.sandboxID);
      const state = sandbox.state ?? "running";
      if (!observed) {
        if (baseline) {
          this.store.upsertObserved({
            sandboxId: sandbox.sandboxID,
            state,
            templateId: sandbox.templateID ?? "",
            executionId: randomUUID(),
            clientId: sandbox.clientID ?? null,
          });
        } else {
          this.record("sandbox.lifecycle.created", { sandboxId: sandbox.sandboxID, templateId: sandbox.templateID }, {
            source: "cube",
            ...(sandbox.metadata ? { sandbox_metadata: sandbox.metadata } : {}),
          });
          if (state === "paused") this.record("sandbox.lifecycle.paused", { sandboxId: sandbox.sandboxID });
        }
        continue;
      }
      if (sandbox.clientID && sandbox.clientID !== observed.clientId) {
        this.store.upsertObserved({ ...observed, clientId: sandbox.clientID });
      }
      if (observed.state !== state) {
        if (state === "paused") this.record("sandbox.lifecycle.paused", { sandboxId: sandbox.sandboxID }, { source: "cube" });
        else if (state === "running") {
          this.record("sandbox.lifecycle.resumed", { sandboxId: sandbox.sandboxID }, { source: "cube" });
        }
      }
    }
    for (const observed of this.store.listObserved()) {
      if (!seen.has(observed.sandboxId)) {
        this.record("sandbox.lifecycle.killed", { sandboxId: observed.sandboxId }, { source: "cube" });
      }
    }
    if (baseline) this.store.ensureSetting("events_baseline", () => new Date().toISOString());

    const now = Date.now();
    const intervalSeconds = Math.max(1, Math.round((now - this.lastSampleMs) / 1000));
    this.store.insertTeamMetric({
      timestampUnix: Math.floor(now / 1000),
      concurrent: live.filter((sandbox) => (sandbox.state ?? "running") === "running").length,
      started: this.store.countEventsSince("sandbox.lifecycle.created", new Date(this.lastSampleMs).toISOString()),
      intervalSeconds,
    });
    this.lastSampleMs = now;
    this.store.pruneHistory(now - this.config.eventRetentionDays * 24 * 60 * 60 * 1000);
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  private dispatch(event: SandboxEventRow): void {
    for (const hook of this.store.listWebhooks()) {
      if (!hook.enabled || !hook.events.includes(event.type)) continue;
      const delivery = this.deliver(hook, event).catch(() => undefined);
      this.pending.add(delivery);
      void delivery.finally(() => this.pending.delete(delivery));
    }
  }

  private async deliver(hook: WebhookRow, event: SandboxEventRow): Promise<void> {
    const body = JSON.stringify(this.toWebhookPayload(event));
    const secret = this.platform.decrypt(hook.secret);
    for (const delayMs of this.retryDelaysMs) {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const current = this.store.getWebhook(hook.id);
      if (!current || !current.enabled) return;
      const attempt = await this.attempt(current, event, body, secret);
      this.store.insertDelivery(attempt);
      if (attempt.status === "success") return;
    }
  }

  private async attempt(
    hook: WebhookRow,
    event: SandboxEventRow,
    body: string,
    secret: string
  ): Promise<WebhookDeliveryRow> {
    const deliveryId = randomUUID();
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": "cube-e2b-shim-webhooks",
      "e2b-webhook-id": hook.id,
      "e2b-delivery-id": deliveryId,
      "e2b-event-type": event.type,
      "e2b-signature": webhookSignature(secret, body),
    };
    const started = Date.now();
    const base: WebhookDeliveryRow = {
      id: deliveryId,
      webhookId: hook.id,
      eventId: event.id,
      sandboxId: event.sandboxId,
      eventType: event.type,
      status: "failed",
      durationMs: 0,
      requestBody: body,
      requestHeaders: JSON.stringify({ ...headers, "e2b-signature": "[REDACTED]" }),
      requestUrl: hook.url,
      responseBody: null,
      responseHeaders: null,
      responseHttpStatusCode: null,
      errorClass: null,
      errorMessage: null,
      timestamp: new Date(started).toISOString(),
    };
    try {
      const response = await fetch(hook.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      const text = await response.text().catch(() => "");
      return {
        ...base,
        status: response.ok ? "success" : "failed",
        durationMs: Date.now() - started,
        responseBody: text.slice(0, MAX_STORED_BODY),
        responseHeaders: JSON.stringify(Object.fromEntries(response.headers.entries())),
        responseHttpStatusCode: response.status,
        errorClass: response.ok ? null : "http_error",
        errorMessage: response.ok ? null : `HTTP ${response.status}`,
      };
    } catch (error) {
      const err = error as Error & { cause?: { code?: string } };
      const code = err.cause?.code ?? "";
      const errorClass =
        err.name === "TimeoutError"
          ? "timeout"
          : code === "ENOTFOUND" || code === "EAI_AGAIN"
            ? "dns_error"
            : err instanceof TypeError && !code
              ? "request_error"
              : "transport_error";
      return {
        ...base,
        durationMs: Date.now() - started,
        errorClass,
        errorMessage: code ? `${code}: ${err.message}` : err.message,
      };
    }
  }
}
