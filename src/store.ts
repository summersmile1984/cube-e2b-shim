/**
 * Shim-side persistent state (node:sqlite, WAL for file-backed DBs).
 *
 * Tracks what CubeSandbox does not give us: per-sandbox envd access tokens
 * (minted for v2 creates and v1 `secure: true`), the token each shim-made
 * memory snapshot carries, and the last known
 * lifecycle state, which the connect handler needs to answer 200 vs 201 with
 * E2B semantics (Cube returns 200 for both).
 */

import { DatabaseSync } from "node:sqlite";

export interface SandboxRow {
  sandboxId: string;
  templateId: string;
  createdAtMs: number;
  timeoutSeconds: number | null;
  autoPause: boolean;
  lastKnownState: string;
  /** Plaintext envd access token; the DB never leaves this host (0600 dir). */
  envdToken: string | null;
  /**
   * Cube traffic access token minted when a create request disables public
   * traffic. The E2B JS SDK stores it but does not replay it on envd calls, so
   * the shim keeps it and injects `e2b-traffic-access-token` upstream.
   */
  trafficToken: string | null;
}

export type BuildStatus = "waiting" | "building" | "ready" | "error";

export interface BuildLogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  step?: string;
}

export interface BuildReason {
  message: string;
  step?: string;
  logEntries?: BuildLogEntry[];
}

export interface BuildRow {
  buildId: string;
  templateId: string;
  status: BuildStatus;
  reason: BuildReason | null;
  request: unknown;
  createdAtMs: number;
}

/** The E2B build context a template ends with (inherited by `fromTemplate`). */
export interface TemplateContext {
  user?: string;
  workdir?: string;
  envVars: Record<string, string>;
}

export interface TemplateNameRow {
  name: string;
  /** Cube template (a memory snapshot) serving this E2B template name. */
  cubeTemplateId: string;
  buildId: string;
  context: TemplateContext;
}

export class ShimStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    if (dbPath !== ":memory:") {
      this.db.exec("PRAGMA journal_mode = WAL");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sandboxes (
        sandbox_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        timeout_seconds INTEGER,
        auto_pause INTEGER NOT NULL DEFAULT 0,
        last_known_state TEXT NOT NULL DEFAULT 'running',
        envd_token TEXT,
        traffic_token TEXT,
        updated_at_ms INTEGER NOT NULL
      )
    `);
    const columns = this.db.prepare("PRAGMA table_info(sandboxes)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "traffic_token")) {
      this.db.exec("ALTER TABLE sandboxes ADD COLUMN traffic_token TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS template_builds (
        build_id TEXT PRIMARY KEY,
        template_id TEXT NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        request_json TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS template_build_logs (
        build_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        message TEXT NOT NULL,
        step TEXT,
        PRIMARY KEY (build_id, seq)
      );
      CREATE TABLE IF NOT EXISTS template_names (
        name TEXT PRIMARY KEY,
        cube_template_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        context_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS image_templates (
        image TEXT PRIMARY KEY,
        cube_template_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_tokens (
        snapshot_id TEXT PRIMARY KEY,
        envd_token TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      )
    `);
  }

  /**
   * Remember the envd token baked into a memory snapshot. envd only lets
   * `/init` change its token when the caller presents the current one (or an
   * MMDS hash Cube does not provide), so every sandbox restored from this
   * snapshot keeps the source token and the shim must hand that token out.
   */
  recordSnapshotToken(snapshotId: string, envdToken: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO snapshot_tokens (snapshot_id, envd_token, created_at_ms)
         VALUES (?, ?, ?)`
      )
      .run(snapshotId, envdToken, Date.now());
  }

  getSnapshotToken(snapshotId: string): string | null {
    const row = this.db
      .prepare("SELECT envd_token FROM snapshot_tokens WHERE snapshot_id = ?")
      .get(snapshotId) as { envd_token: string } | undefined;
    return row?.envd_token ?? null;
  }

  removeSnapshotToken(snapshotId: string): void {
    this.db.prepare("DELETE FROM snapshot_tokens WHERE snapshot_id = ?").run(snapshotId);
  }

  recordSandbox(
    row: Omit<SandboxRow, "lastKnownState" | "trafficToken"> & {
      lastKnownState?: string;
      trafficToken?: string | null;
    }
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sandboxes
         (sandbox_id, template_id, created_at_ms, timeout_seconds, auto_pause, last_known_state, envd_token, traffic_token, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.sandboxId,
        row.templateId,
        row.createdAtMs,
        row.timeoutSeconds,
        row.autoPause ? 1 : 0,
        row.lastKnownState ?? "running",
        row.envdToken,
        row.trafficToken ?? null,
        Date.now()
      );
  }

  getSandbox(sandboxId: string): SandboxRow | null {
    const row = this.db
      .prepare(
        `SELECT sandbox_id, template_id, created_at_ms, timeout_seconds, auto_pause,
                last_known_state, envd_token, traffic_token
         FROM sandboxes WHERE sandbox_id = ?`
      )
      .get(sandboxId) as
      | {
          sandbox_id: string;
          template_id: string;
          created_at_ms: number;
          timeout_seconds: number | null;
          auto_pause: number;
          last_known_state: string;
          envd_token: string | null;
          traffic_token: string | null;
        }
      | undefined;
    if (!row) return null;
    return {
      sandboxId: row.sandbox_id,
      templateId: row.template_id,
      createdAtMs: row.created_at_ms,
      timeoutSeconds: row.timeout_seconds,
      autoPause: row.auto_pause === 1,
      lastKnownState: row.last_known_state,
      envdToken: row.envd_token,
      trafficToken: row.traffic_token,
    };
  }

  setState(sandboxId: string, state: string): void {
    this.db
      .prepare("UPDATE sandboxes SET last_known_state = ?, updated_at_ms = ? WHERE sandbox_id = ?")
      .run(state, Date.now(), sandboxId);
  }

  removeSandbox(sandboxId: string): void {
    this.db.prepare("DELETE FROM sandboxes WHERE sandbox_id = ?").run(sandboxId);
  }

  // -------------------------------------------------------------------------
  // Template builds (E2B v3 step builds executed by the shim)
  // -------------------------------------------------------------------------

  createBuild(build: { buildId: string; templateId: string; request: unknown }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO template_builds
         (build_id, template_id, status, reason, request_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, 'waiting', NULL, ?, ?, ?)`
      )
      .run(build.buildId, build.templateId, JSON.stringify(build.request ?? {}), now, now);
  }

  getBuild(buildId: string): BuildRow | null {
    const row = this.db
      .prepare(
        `SELECT build_id, template_id, status, reason, request_json, created_at_ms
         FROM template_builds WHERE build_id = ?`
      )
      .get(buildId) as
      | {
          build_id: string;
          template_id: string;
          status: string;
          reason: string | null;
          request_json: string;
          created_at_ms: number;
        }
      | undefined;
    if (!row) return null;
    return {
      buildId: row.build_id,
      templateId: row.template_id,
      status: row.status as BuildStatus,
      reason: row.reason ? (JSON.parse(row.reason) as BuildReason) : null,
      request: JSON.parse(row.request_json) as unknown,
      createdAtMs: row.created_at_ms,
    };
  }

  setBuildStatus(buildId: string, status: BuildStatus, reason: BuildReason | null = null): void {
    this.db
      .prepare(
        "UPDATE template_builds SET status = ?, reason = ?, updated_at_ms = ? WHERE build_id = ?"
      )
      .run(status, reason ? JSON.stringify(reason) : null, Date.now(), buildId);
  }

  /** Builds interrupted by a restart can never finish; report them as failed. */
  failInterruptedBuilds(): void {
    this.db
      .prepare(
        `UPDATE template_builds SET status = 'error', reason = ?, updated_at_ms = ?
         WHERE status IN ('waiting', 'building')`
      )
      .run(JSON.stringify({ message: "build interrupted by a service restart" }), Date.now());
  }

  appendBuildLog(buildId: string, entry: BuildLogEntry): void {
    this.db
      .prepare(
        `INSERT INTO template_build_logs (build_id, seq, timestamp, level, message, step)
         VALUES (?, COALESCE((SELECT MAX(seq) + 1 FROM template_build_logs WHERE build_id = ?), 0),
                 ?, ?, ?, ?)`
      )
      .run(buildId, buildId, entry.timestamp, entry.level, entry.message, entry.step ?? null);
  }

  getBuildLogs(buildId: string, offset = 0, limit = 100): BuildLogEntry[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp, level, message, step FROM template_build_logs
         WHERE build_id = ? ORDER BY seq LIMIT ? OFFSET ?`
      )
      .all(buildId, limit, offset) as Array<{
      timestamp: string;
      level: string;
      message: string;
      step: string | null;
    }>;
    return rows.map((row) => ({
      timestamp: row.timestamp,
      level: row.level as BuildLogEntry["level"],
      message: row.message,
      ...(row.step ? { step: row.step } : {}),
    }));
  }

  setTemplateName(
    name: string,
    cubeTemplateId: string,
    buildId: string,
    context: TemplateContext
  ): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO template_names
         (name, cube_template_id, build_id, context_json, updated_at_ms) VALUES (?, ?, ?, ?, ?)`
      )
      .run(name, cubeTemplateId, buildId, JSON.stringify(context), Date.now());
  }

  getTemplateName(name: string): TemplateNameRow | null {
    const row = this.db
      .prepare(
        "SELECT name, cube_template_id, build_id, context_json FROM template_names WHERE name = ?"
      )
      .get(name) as
      | { name: string; cube_template_id: string; build_id: string; context_json: string }
      | undefined;
    if (!row) return null;
    return {
      name: row.name,
      cubeTemplateId: row.cube_template_id,
      buildId: row.build_id,
      context: JSON.parse(row.context_json) as TemplateContext,
    };
  }

  removeTemplateName(name: string): void {
    this.db.prepare("DELETE FROM template_names WHERE name = ?").run(name);
  }

  setImageTemplate(image: string, cubeTemplateId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO image_templates (image, cube_template_id, created_at_ms)
         VALUES (?, ?, ?)`
      )
      .run(image, cubeTemplateId, Date.now());
  }

  getImageTemplate(image: string): string | null {
    const row = this.db
      .prepare("SELECT cube_template_id FROM image_templates WHERE image = ?")
      .get(image) as { cube_template_id: string } | undefined;
    return row?.cube_template_id ?? null;
  }

  removeImageTemplate(image: string): void {
    this.db.prepare("DELETE FROM image_templates WHERE image = ?").run(image);
  }

  close(): void {
    this.db.close();
  }
}
