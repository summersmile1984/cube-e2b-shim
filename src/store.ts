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
  updatedAtMs: number;
  finishedAtMs: number | null;
  cubeTemplateId: string | null;
}

/** The E2B build context a template ends with (inherited by `fromTemplate`). */
export interface TemplateContext {
  user?: string;
  workdir?: string;
  envVars: Record<string, string>;
}

export interface TemplateMeta {
  public: boolean;
  spawnCount: number;
  lastSpawnedAt: string | null;
  envdVersion: string | null;
}

export interface TemplateNameRow {
  name: string;
  tag: string;
  /** Cube template (a memory snapshot) serving this E2B template name. */
  cubeTemplateId: string;
  buildId: string;
  context: TemplateContext;
}

export interface ApiKeyMask {
  prefix: string;
  valueLength: number;
  maskedValuePrefix: string;
  maskedValueSuffix: string;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  mask: ApiKeyMask;
  createdAt: string;
  lastUsed: string | null;
}

export interface SandboxEventRow {
  id: string;
  sandboxId: string;
  type: string;
  timestamp: string;
  executionId: string;
  templateId: string;
  buildId: string;
  data: Record<string, unknown> | null;
}

export interface ObservedSandbox {
  sandboxId: string;
  state: string;
  templateId: string;
  executionId: string;
  /** Cube host (clientID) the sandbox runs on. */
  clientId?: string | null;
}

export interface TeamMetricRow {
  timestampUnix: number;
  concurrent: number;
  started: number;
  intervalSeconds: number;
}

export interface WebhookRow {
  id: string;
  name: string;
  url: string;
  events: string[];
  enabled: boolean;
  /** Encrypted signing secret. */
  secret: string;
  createdAt: string;
}

export interface WebhookDeliveryRow {
  id: string;
  webhookId: string;
  eventId: string;
  sandboxId: string;
  eventType: string;
  status: "success" | "failed";
  durationMs: number;
  requestBody: string;
  requestHeaders: string;
  requestUrl: string;
  responseBody: string | null;
  responseHeaders: string | null;
  responseHttpStatusCode: number | null;
  errorClass: string | null;
  errorMessage: string | null;
  timestamp: string;
}

export interface SecretRow {
  id: string;
  name: string;
  currentVersion: number;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
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
    if (!columns.some((column) => column.name === "network_json")) {
      this.db.exec("ALTER TABLE sandboxes ADD COLUMN network_json TEXT");
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sandbox_events (
        id TEXT PRIMARY KEY,
        sandbox_id TEXT NOT NULL,
        type TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        template_id TEXT NOT NULL,
        build_id TEXT NOT NULL,
        data_json TEXT
      );
      CREATE INDEX IF NOT EXISTS sandbox_events_ts ON sandbox_events (timestamp);
      CREATE INDEX IF NOT EXISTS sandbox_events_sbx ON sandbox_events (sandbox_id, timestamp);
      CREATE TABLE IF NOT EXISTS observed_sandboxes (
        sandbox_id TEXT PRIMARY KEY,
        state TEXT NOT NULL,
        template_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        client_id TEXT,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS team_metrics (
        timestamp_unix INTEGER PRIMARY KEY,
        concurrent INTEGER NOT NULL,
        started INTEGER NOT NULL,
        interval_seconds INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL,
        enabled INTEGER NOT NULL,
        secret TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        sandbox_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        request_body TEXT NOT NULL,
        request_headers TEXT NOT NULL,
        request_url TEXT NOT NULL,
        response_body TEXT,
        response_headers TEXT,
        response_status INTEGER,
        error_class TEXT,
        error_message TEXT,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries (webhook_id, timestamp);
      CREATE TABLE IF NOT EXISTS secrets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        value TEXT NOT NULL,
        version INTEGER NOT NULL,
        metadata_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL UNIQUE,
        mask_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used TEXT
      );
    `);
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
      CREATE TABLE IF NOT EXISTS template_tags (
        name TEXT NOT NULL,
        tag TEXT NOT NULL,
        build_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (name, tag)
      );
      CREATE TABLE IF NOT EXISTS template_meta (
        ref TEXT PRIMARY KEY,
        public INTEGER NOT NULL DEFAULT 0,
        spawn_count INTEGER NOT NULL DEFAULT 0,
        last_spawned_at TEXT,
        envd_version TEXT
      );
      CREATE TABLE IF NOT EXISTS image_templates (
        image TEXT PRIMARY KEY,
        cube_template_id TEXT NOT NULL,
        created_at_ms INTEGER NOT NULL
      );
    `);
    const buildColumns = this.db.prepare("PRAGMA table_info(template_builds)").all() as Array<{
      name: string;
    }>;
    for (const [column, type] of [
      ["cube_template_id", "TEXT"],
      ["context_json", "TEXT"],
      ["finished_at_ms", "INTEGER"],
    ]) {
      if (!buildColumns.some((c) => c.name === column)) {
        this.db.exec(`ALTER TABLE template_builds ADD COLUMN ${column} ${type}`);
      }
    }
    // Earlier releases kept one build per name in template_names.
    const legacy = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'template_names'")
      .get();
    if (legacy) {
      this.db.exec(`
        UPDATE template_builds SET
          cube_template_id = (SELECT cube_template_id FROM template_names n WHERE n.build_id = template_builds.build_id),
          context_json = (SELECT context_json FROM template_names n WHERE n.build_id = template_builds.build_id)
        WHERE build_id IN (SELECT build_id FROM template_names);
        INSERT OR IGNORE INTO template_tags (name, tag, build_id, created_at)
          SELECT name, 'default', build_id, strftime('%Y-%m-%dT%H:%M:%fZ', updated_at_ms / 1000.0, 'unixepoch')
          FROM template_names;
        DROP TABLE template_names;
      `);
    }
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
        `SELECT build_id, template_id, status, reason, request_json, created_at_ms, updated_at_ms,
                finished_at_ms, cube_template_id
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
          updated_at_ms: number;
          finished_at_ms: number | null;
          cube_template_id: string | null;
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
      updatedAtMs: row.updated_at_ms,
      finishedAtMs: row.finished_at_ms,
      cubeTemplateId: row.cube_template_id,
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

  // -------------------------------------------------------------------------
  // Built templates: tags point E2B names at builds; builds carry the Cube
  // template (memory snapshot) and final build context.
  // -------------------------------------------------------------------------

  completeBuild(buildId: string, cubeTemplateId: string, context: TemplateContext): void {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE template_builds SET status = 'ready', reason = NULL, cube_template_id = ?, context_json = ?,
         finished_at_ms = ?, updated_at_ms = ? WHERE build_id = ?`
      )
      .run(cubeTemplateId, JSON.stringify(context), now, now, buildId);
  }

  assignTags(name: string, tags: string[], buildId: string): void {
    const statement = this.db.prepare(
      "INSERT OR REPLACE INTO template_tags (name, tag, build_id, created_at) VALUES (?, ?, ?, ?)"
    );
    const now = new Date().toISOString();
    for (const tag of tags) statement.run(name, tag, buildId, now);
  }

  /** Resolve `name` + tag (E2B's implicit tag is `default`) to its build. */
  resolveTemplateTag(name: string, tag = "default"): TemplateNameRow | null {
    const row = this.db
      .prepare(
        `SELECT t.name, t.tag, t.build_id, b.cube_template_id, b.context_json
         FROM template_tags t JOIN template_builds b ON b.build_id = t.build_id
         WHERE t.name = ? AND t.tag = ? AND b.cube_template_id IS NOT NULL`
      )
      .get(name, tag) as
      | { name: string; tag: string; build_id: string; cube_template_id: string; context_json: string | null }
      | undefined;
    if (!row) return null;
    return {
      name: row.name,
      tag: row.tag,
      cubeTemplateId: row.cube_template_id,
      buildId: row.build_id,
      context: row.context_json ? (JSON.parse(row.context_json) as TemplateContext) : { envVars: {} },
    };
  }

  /** `name` or `name:tag` reference to a built template. */
  getTemplateName(ref: string): TemplateNameRow | null {
    const colon = ref.lastIndexOf(":");
    return colon > 0 ? this.resolveTemplateTag(ref.slice(0, colon), ref.slice(colon + 1)) : this.resolveTemplateTag(ref);
  }

  hasTemplate(name: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM template_tags WHERE name = ? LIMIT 1").get(name));
  }

  listTemplateNames(): string[] {
    return (
      this.db.prepare("SELECT DISTINCT name FROM template_tags ORDER BY name").all() as Array<{ name: string }>
    ).map((row) => row.name);
  }

  listTags(name: string): Array<{ tag: string; buildId: string; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT tag, build_id, created_at FROM template_tags WHERE name = ? ORDER BY created_at, tag")
      .all(name) as Array<{ tag: string; build_id: string; created_at: string }>;
    return rows.map((row) => ({ tag: row.tag, buildId: row.build_id, createdAt: row.created_at }));
  }

  deleteTags(name: string, tags: string[]): number {
    const statement = this.db.prepare("DELETE FROM template_tags WHERE name = ? AND tag = ?");
    return tags.reduce((count, tag) => count + Number(statement.run(name, tag).changes), 0);
  }

  /** Ready builds of `name` whose Cube template no tag references any more. */
  unreferencedBuilds(name: string): Array<{ buildId: string; cubeTemplateId: string }> {
    const rows = this.db
      .prepare(
        `SELECT build_id, cube_template_id FROM template_builds
         WHERE template_id = ? AND cube_template_id IS NOT NULL
           AND build_id NOT IN (SELECT build_id FROM template_tags WHERE name = ?)`
      )
      .all(name, name) as Array<{ build_id: string; cube_template_id: string }>;
    return rows.map((row) => ({ buildId: row.build_id, cubeTemplateId: row.cube_template_id }));
  }

  /** The Cube template of a build was deleted. */
  clearBuildTemplate(buildId: string): void {
    this.db.prepare("UPDATE template_builds SET cube_template_id = NULL WHERE build_id = ?").run(buildId);
  }

  listBuilds(name: string): BuildRow[] {
    const rows = this.db
      .prepare("SELECT build_id FROM template_builds WHERE template_id = ? ORDER BY created_at_ms DESC")
      .all(name) as Array<{ build_id: string }>;
    return rows.map((row) => this.getBuild(row.build_id) as BuildRow);
  }

  /** Forget a built template: its tags, builds and logs. Returns its live Cube templates. */
  deleteTemplate(name: string): string[] {
    const cubeTemplates = (
      this.db
        .prepare("SELECT cube_template_id FROM template_builds WHERE template_id = ? AND cube_template_id IS NOT NULL")
        .all(name) as Array<{ cube_template_id: string }>
    ).map((row) => row.cube_template_id);
    this.db.prepare("DELETE FROM template_tags WHERE name = ?").run(name);
    this.db
      .prepare("DELETE FROM template_build_logs WHERE build_id IN (SELECT build_id FROM template_builds WHERE template_id = ?)")
      .run(name);
    this.db.prepare("DELETE FROM template_builds WHERE template_id = ?").run(name);
    this.db.prepare("DELETE FROM template_meta WHERE ref = ?").run(name);
    return cubeTemplates;
  }

  findTemplateByCubeId(cubeTemplateId: string): TemplateNameRow | null {
    const row = this.db
      .prepare(
        `SELECT b.template_id, b.build_id, b.context_json FROM template_builds b
         WHERE b.cube_template_id = ?`
      )
      .get(cubeTemplateId) as { template_id: string; build_id: string; context_json: string | null } | undefined;
    if (!row) return null;
    const tag = this.db
      .prepare("SELECT tag FROM template_tags WHERE name = ? AND build_id = ? ORDER BY tag LIMIT 1")
      .get(row.template_id, row.build_id) as { tag: string } | undefined;
    return {
      name: row.template_id,
      tag: tag?.tag ?? "",
      cubeTemplateId,
      buildId: row.build_id,
      context: row.context_json ? (JSON.parse(row.context_json) as TemplateContext) : { envVars: {} },
    };
  }

  // Per-template flags and usage (keyed by E2B name or Cube template ID).

  getTemplateMeta(ref: string): TemplateMeta {
    const row = this.db
      .prepare("SELECT public, spawn_count, last_spawned_at, envd_version FROM template_meta WHERE ref = ?")
      .get(ref) as
      | { public: number; spawn_count: number; last_spawned_at: string | null; envd_version: string | null }
      | undefined;
    return {
      public: row?.public === 1,
      spawnCount: row?.spawn_count ?? 0,
      lastSpawnedAt: row?.last_spawned_at ?? null,
      envdVersion: row?.envd_version ?? null,
    };
  }

  setTemplatePublic(ref: string, isPublic: boolean): void {
    this.db
      .prepare(
        `INSERT INTO template_meta (ref, public) VALUES (?, ?)
         ON CONFLICT(ref) DO UPDATE SET public = excluded.public`
      )
      .run(ref, isPublic ? 1 : 0);
  }

  recordSpawn(ref: string, envdVersion: string | null): void {
    this.db
      .prepare(
        `INSERT INTO template_meta (ref, spawn_count, last_spawned_at, envd_version) VALUES (?, 1, ?, ?)
         ON CONFLICT(ref) DO UPDATE SET spawn_count = spawn_count + 1,
           last_spawned_at = excluded.last_spawned_at,
           envd_version = COALESCE(excluded.envd_version, envd_version)`
      )
      .run(ref, new Date().toISOString(), envdVersion);
  }

  isImageTemplate(cubeTemplateId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM image_templates WHERE cube_template_id = ?").get(cubeTemplateId)
    );
  }

  isBuiltTemplate(cubeTemplateId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM template_builds WHERE cube_template_id = ?").get(cubeTemplateId)
    );
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

  // -------------------------------------------------------------------------
  // Settings and managed API keys
  // -------------------------------------------------------------------------

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** Return the stored value, or store and return `fallback` when unset. */
  ensureSetting(key: string, fallback: () => string): string {
    const existing = this.getSetting(key);
    if (existing !== null) return existing;
    const value = fallback();
    this.db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run(key, value);
    return this.getSetting(key) as string;
  }

  createApiKey(key: ApiKeyRow & { keyHash: string }): void {
    this.db
      .prepare(
        `INSERT INTO api_keys (id, name, key_hash, mask_json, created_at, last_used)
         VALUES (?, ?, ?, ?, ?, NULL)`
      )
      .run(key.id, key.name, key.keyHash, JSON.stringify(key.mask), key.createdAt);
  }

  listApiKeys(): ApiKeyRow[] {
    const rows = this.db
      .prepare("SELECT id, name, mask_json, created_at, last_used FROM api_keys ORDER BY created_at")
      .all() as Array<{
      id: string;
      name: string;
      mask_json: string;
      created_at: string;
      last_used: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      mask: JSON.parse(row.mask_json) as ApiKeyMask,
      createdAt: row.created_at,
      lastUsed: row.last_used,
    }));
  }

  findApiKeyByHash(keyHash: string): string | null {
    const row = this.db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(keyHash) as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  touchApiKey(id: string): void {
    this.db
      .prepare("UPDATE api_keys SET last_used = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
  }

  renameApiKey(id: string, name: string): boolean {
    return this.db.prepare("UPDATE api_keys SET name = ? WHERE id = ?").run(name, id).changes > 0;
  }

  deleteApiKey(id: string): boolean {
    return this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes > 0;
  }

  // -------------------------------------------------------------------------
  // Sandbox events, observed Cube state and team metrics
  // -------------------------------------------------------------------------

  insertEvent(event: SandboxEventRow): void {
    this.db
      .prepare(
        `INSERT INTO sandbox_events
         (id, sandbox_id, type, timestamp, execution_id, template_id, build_id, data_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.id,
        event.sandboxId,
        event.type,
        event.timestamp,
        event.executionId,
        event.templateId,
        event.buildId,
        event.data ? JSON.stringify(event.data) : null
      );
  }

  listEvents(filter: {
    sandboxId?: string;
    types?: string[];
    offset: number;
    limit: number;
    orderAsc: boolean;
  }): SandboxEventRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.sandboxId) {
      where.push("sandbox_id = ?");
      args.push(filter.sandboxId);
    }
    if (filter.types && filter.types.length > 0) {
      where.push(`type IN (${filter.types.map(() => "?").join(", ")})`);
      args.push(...filter.types);
    }
    const rows = this.db
      .prepare(
        `SELECT id, sandbox_id, type, timestamp, execution_id, template_id, build_id, data_json
         FROM sandbox_events ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY timestamp ${filter.orderAsc ? "ASC" : "DESC"}, rowid ${filter.orderAsc ? "ASC" : "DESC"}
         LIMIT ? OFFSET ?`
      )
      .all(...args, filter.limit, filter.offset) as Array<{
      id: string;
      sandbox_id: string;
      type: string;
      timestamp: string;
      execution_id: string;
      template_id: string;
      build_id: string;
      data_json: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      sandboxId: row.sandbox_id,
      type: row.type,
      timestamp: row.timestamp,
      executionId: row.execution_id,
      templateId: row.template_id,
      buildId: row.build_id,
      data: row.data_json ? (JSON.parse(row.data_json) as Record<string, unknown>) : null,
    }));
  }

  hasEvents(sandboxId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 FROM sandbox_events WHERE sandbox_id = ? LIMIT 1").get(sandboxId)
    );
  }

  countEventsSince(type: string, sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM sandbox_events WHERE type = ? AND timestamp >= ?")
      .get(type, sinceIso) as { n: number };
    return row.n;
  }

  getObserved(sandboxId: string): ObservedSandbox | null {
    const row = this.db
      .prepare(
        "SELECT sandbox_id, state, template_id, execution_id, client_id FROM observed_sandboxes WHERE sandbox_id = ?"
      )
      .get(sandboxId) as
      | { sandbox_id: string; state: string; template_id: string; execution_id: string; client_id: string | null }
      | undefined;
    return row
      ? {
          sandboxId: row.sandbox_id,
          state: row.state,
          templateId: row.template_id,
          executionId: row.execution_id,
          clientId: row.client_id,
        }
      : null;
  }

  listObserved(): ObservedSandbox[] {
    const rows = this.db
      .prepare("SELECT sandbox_id, state, template_id, execution_id, client_id FROM observed_sandboxes")
      .all() as Array<{
      sandbox_id: string;
      state: string;
      template_id: string;
      execution_id: string;
      client_id: string | null;
    }>;
    return rows.map((row) => ({
      sandboxId: row.sandbox_id,
      state: row.state,
      templateId: row.template_id,
      executionId: row.execution_id,
      clientId: row.client_id,
    }));
  }

  upsertObserved(observed: ObservedSandbox): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO observed_sandboxes
         (sandbox_id, state, template_id, execution_id, client_id, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        observed.sandboxId,
        observed.state,
        observed.templateId,
        observed.executionId,
        observed.clientId ?? null,
        Date.now()
      );
  }

  removeObserved(sandboxId: string): void {
    this.db.prepare("DELETE FROM observed_sandboxes WHERE sandbox_id = ?").run(sandboxId);
  }

  insertTeamMetric(metric: TeamMetricRow): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO team_metrics (timestamp_unix, concurrent, started, interval_seconds)
         VALUES (?, ?, ?, ?)`
      )
      .run(metric.timestampUnix, metric.concurrent, metric.started, metric.intervalSeconds);
  }

  listTeamMetrics(startUnix: number, endUnix: number): TeamMetricRow[] {
    const rows = this.db
      .prepare(
        `SELECT timestamp_unix, concurrent, started, interval_seconds FROM team_metrics
         WHERE timestamp_unix >= ? AND timestamp_unix <= ? ORDER BY timestamp_unix`
      )
      .all(startUnix, endUnix) as Array<{
      timestamp_unix: number;
      concurrent: number;
      started: number;
      interval_seconds: number;
    }>;
    return rows.map((row) => ({
      timestampUnix: row.timestamp_unix,
      concurrent: row.concurrent,
      started: row.started,
      intervalSeconds: row.interval_seconds,
    }));
  }

  /** Drop events, deliveries and metrics older than the retention window. */
  pruneHistory(cutoffMs: number): void {
    const iso = new Date(cutoffMs).toISOString();
    this.db.prepare("DELETE FROM sandbox_events WHERE timestamp < ?").run(iso);
    this.db.prepare("DELETE FROM webhook_deliveries WHERE timestamp < ?").run(iso);
    this.db.prepare("DELETE FROM team_metrics WHERE timestamp_unix < ?").run(Math.floor(cutoffMs / 1000));
  }

  // -------------------------------------------------------------------------
  // Webhooks and their delivery attempts
  // -------------------------------------------------------------------------

  createWebhook(hook: WebhookRow): void {
    this.db
      .prepare(
        `INSERT INTO webhooks (id, name, url, events_json, enabled, secret, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(hook.id, hook.name, hook.url, JSON.stringify(hook.events), hook.enabled ? 1 : 0, hook.secret, hook.createdAt);
  }

  updateWebhook(hook: WebhookRow): void {
    this.db
      .prepare("UPDATE webhooks SET name = ?, url = ?, events_json = ?, enabled = ?, secret = ? WHERE id = ?")
      .run(hook.name, hook.url, JSON.stringify(hook.events), hook.enabled ? 1 : 0, hook.secret, hook.id);
  }

  private static webhookFromRow(row: {
    id: string;
    name: string;
    url: string;
    events_json: string;
    enabled: number;
    secret: string;
    created_at: string;
  }): WebhookRow {
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      events: JSON.parse(row.events_json) as string[],
      enabled: row.enabled === 1,
      secret: row.secret,
      createdAt: row.created_at,
    };
  }

  getWebhook(id: string): WebhookRow | null {
    const row = this.db.prepare("SELECT * FROM webhooks WHERE id = ?").get(id) as
      | Parameters<typeof ShimStore.webhookFromRow>[0]
      | undefined;
    return row ? ShimStore.webhookFromRow(row) : null;
  }

  listWebhooks(): WebhookRow[] {
    const rows = this.db.prepare("SELECT * FROM webhooks ORDER BY created_at").all() as Array<
      Parameters<typeof ShimStore.webhookFromRow>[0]
    >;
    return rows.map((row) => ShimStore.webhookFromRow(row));
  }

  deleteWebhook(id: string): boolean {
    const changed = this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes > 0;
    this.db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
    return changed;
  }

  insertDelivery(delivery: WebhookDeliveryRow): void {
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries
         (id, webhook_id, event_id, sandbox_id, event_type, status, duration_ms, request_body,
          request_headers, request_url, response_body, response_headers, response_status,
          error_class, error_message, timestamp)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        delivery.id,
        delivery.webhookId,
        delivery.eventId,
        delivery.sandboxId,
        delivery.eventType,
        delivery.status,
        delivery.durationMs,
        delivery.requestBody,
        delivery.requestHeaders,
        delivery.requestUrl,
        delivery.responseBody,
        delivery.responseHeaders,
        delivery.responseHttpStatusCode,
        delivery.errorClass,
        delivery.errorMessage,
        delivery.timestamp
      );
  }

  listDeliveries(webhookId: string, filter: { start?: string; end?: string }): WebhookDeliveryRow[] {
    const where = ["webhook_id = ?"];
    const args: string[] = [webhookId];
    if (filter.start) {
      where.push("timestamp >= ?");
      args.push(filter.start);
    }
    if (filter.end) {
      where.push("timestamp < ?");
      args.push(filter.end);
    }
    const rows = this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE ${where.join(" AND ")} ORDER BY timestamp, rowid`)
      .all(...args) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      id: String(row.id),
      webhookId: String(row.webhook_id),
      eventId: String(row.event_id),
      sandboxId: String(row.sandbox_id),
      eventType: String(row.event_type),
      status: row.status as "success" | "failed",
      durationMs: Number(row.duration_ms),
      requestBody: String(row.request_body),
      requestHeaders: String(row.request_headers),
      requestUrl: String(row.request_url),
      responseBody: row.response_body === null ? null : String(row.response_body),
      responseHeaders: row.response_headers === null ? null : String(row.response_headers),
      responseHttpStatusCode: row.response_status === null ? null : Number(row.response_status),
      errorClass: row.error_class === null ? null : String(row.error_class),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      timestamp: String(row.timestamp),
    }));
  }

  // -------------------------------------------------------------------------
  // Secrets (values encrypted by the caller) and per-sandbox network configs
  // -------------------------------------------------------------------------

  createSecret(secret: SecretRow & { value: string }): void {
    this.db
      .prepare(
        `INSERT INTO secrets (id, name, value, version, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        secret.id,
        secret.name,
        secret.value,
        secret.currentVersion,
        JSON.stringify(secret.metadata),
        secret.createdAt,
        secret.updatedAt
      );
  }

  private static secretFromRow(row: {
    id: string;
    name: string;
    version: number;
    metadata_json: string;
    created_at: string;
    updated_at: string;
  }): SecretRow {
    return {
      id: row.id,
      name: row.name,
      currentVersion: row.version,
      metadata: JSON.parse(row.metadata_json) as Record<string, string>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /** Look a secret up by `sec_` ID or canonical (lower-case) name. */
  getSecret(idOrName: string): SecretRow | null {
    const row = this.db
      .prepare("SELECT * FROM secrets WHERE id = ? OR name = ?")
      .get(idOrName, idOrName.toLowerCase()) as Parameters<typeof ShimStore.secretFromRow>[0] | undefined;
    return row ? ShimStore.secretFromRow(row) : null;
  }

  getSecretValue(name: string): string | null {
    const row = this.db.prepare("SELECT value FROM secrets WHERE name = ?").get(name.toLowerCase()) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  listSecrets(offset: number, limit: number): SecretRow[] {
    const rows = this.db
      .prepare("SELECT * FROM secrets ORDER BY created_at, id LIMIT ? OFFSET ?")
      .all(limit, offset) as Array<Parameters<typeof ShimStore.secretFromRow>[0]>;
    return rows.map((row) => ShimStore.secretFromRow(row));
  }

  countSecrets(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM secrets").get() as { n: number }).n;
  }

  updateSecret(id: string, value: string, metadata: Record<string, string> | null): SecretRow | null {
    const now = new Date().toISOString();
    const result = metadata
      ? this.db
          .prepare(
            "UPDATE secrets SET value = ?, version = version + 1, metadata_json = ?, updated_at = ? WHERE id = ?"
          )
          .run(value, JSON.stringify(metadata), now, id)
      : this.db
          .prepare("UPDATE secrets SET value = ?, version = version + 1, updated_at = ? WHERE id = ?")
          .run(value, now, id);
    return result.changes > 0 ? this.getSecret(id) : null;
  }

  deleteSecret(id: string): boolean {
    return this.db.prepare("DELETE FROM secrets WHERE id = ?").run(id).changes > 0;
  }

  /** The caller-facing network config (secret placeholders unresolved). */
  setSandboxNetwork(sandboxId: string, network: unknown): void {
    this.db
      .prepare("UPDATE sandboxes SET network_json = ? WHERE sandbox_id = ?")
      .run(network === undefined ? null : JSON.stringify(network), sandboxId);
  }

  getSandboxNetwork(sandboxId: string): unknown {
    const row = this.db.prepare("SELECT network_json FROM sandboxes WHERE sandbox_id = ?").get(sandboxId) as
      | { network_json: string | null }
      | undefined;
    return row?.network_json ? (JSON.parse(row.network_json) as unknown) : undefined;
  }

  close(): void {
    this.db.close();
  }
}
