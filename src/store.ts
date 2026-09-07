/**
 * Shim-side persistent state (node:sqlite, WAL for file-backed DBs).
 *
 * Tracks what CubeSandbox does not give us: per-sandbox envd access tokens
 * (generated when the client creates with `secure: true`) and the last known
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
        updated_at_ms INTEGER NOT NULL
      )
    `);
  }

  recordSandbox(row: Omit<SandboxRow, "lastKnownState"> & { lastKnownState?: string }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO sandboxes
         (sandbox_id, template_id, created_at_ms, timeout_seconds, auto_pause, last_known_state, envd_token, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.sandboxId,
        row.templateId,
        row.createdAtMs,
        row.timeoutSeconds,
        row.autoPause ? 1 : 0,
        row.lastKnownState ?? "running",
        row.envdToken,
        Date.now()
      );
  }

  getSandbox(sandboxId: string): SandboxRow | null {
    const row = this.db
      .prepare(
        `SELECT sandbox_id, template_id, created_at_ms, timeout_seconds, auto_pause,
                last_known_state, envd_token
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
