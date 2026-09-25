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

  close(): void {
    this.db.close();
  }
}
