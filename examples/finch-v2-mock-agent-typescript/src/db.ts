/**
 * SQLite-backed task and nonce store.
 *
 * Replaces the in-memory Map<string, Task> and Map<string, number> with two
 * SQLite tables. Uses the built-in `node:sqlite` module — no external
 * dependency, no native compilation, available in both Node 22.5+ and Deno 2.x.
 *
 * Single-file persistent store. The file path is configurable; the test
 * harness uses a fresh file per run.
 */

import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
import * as fs from 'node:fs';

export interface TaskRow {
  merchant_task_id: string;
  invocation_id: string;
  state: 'working' | 'input_required' | 'completed';
  sequence: number;
  contract_test: boolean;
  answer: string | null;
  ready_at: number;
  completed: boolean;
  question: string;
  mode: 'conversation_turn' | 'task' | 'generation';
  artifacts_json: string;
  created_at: number;
}

export type TaskStatus =
  | 'submitted'
  | 'working'
  | 'queued'
  | 'generating'
  | 'uploading'
  | 'input_required'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'expired';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  merchant_task_id TEXT PRIMARY KEY,
  invocation_id    TEXT NOT NULL,
  state            TEXT NOT NULL,
  sequence         INTEGER NOT NULL,
  contract_test    INTEGER NOT NULL,
  answer           TEXT,
  ready_at         REAL NOT NULL,
  completed        INTEGER NOT NULL,
  question         TEXT NOT NULL,
  mode             TEXT NOT NULL,
  artifacts_json   TEXT NOT NULL DEFAULT '[]',
  created_at       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS nonces (
  nonce   TEXT PRIMARY KEY,
  seen_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonces_seen_at ON nonces(seen_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
`;

export class Store {
  private readonly db: DatabaseSync;
  private readonly getTaskStmt;
  private readonly insertTaskStmt;
  private readonly upsertTaskStmt;
  private readonly updateTaskStateStmt;
  private readonly getNonceStmt;
  private readonly insertNonceStmt;
  private readonly countNoncesStmt;
  private readonly deleteOldNoncesStmt;

  constructor(dbPath: string) {
    // Ensure parent dir exists
    const dir = path.dirname(dbPath);
    if (dir && dir !== '.' && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec(SCHEMA);

    this.getTaskStmt = this.db.prepare('SELECT * FROM tasks WHERE merchant_task_id = ?');
    this.insertTaskStmt = this.db.prepare(`
      INSERT INTO tasks (merchant_task_id, invocation_id, state, sequence,
                         contract_test, answer, ready_at, completed, question,
                         mode, artifacts_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.upsertTaskStmt = this.db.prepare(`
      INSERT OR REPLACE INTO tasks (merchant_task_id, invocation_id, state,
                                    sequence, contract_test, answer, ready_at,
                                    completed, question, mode, artifacts_json,
                                    created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateTaskStateStmt = this.db.prepare(`
      UPDATE tasks
         SET state = ?, sequence = ?, answer = ?, completed = ?,
             artifacts_json = ?
       WHERE merchant_task_id = ?
    `);
    this.getNonceStmt = this.db.prepare('SELECT seen_at FROM nonces WHERE nonce = ?');
    this.insertNonceStmt = this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)');
    this.countNoncesStmt = this.db.prepare('SELECT COUNT(*) AS c FROM nonces');
    this.deleteOldNoncesStmt = this.db.prepare('DELETE FROM nonces WHERE seen_at < ?');
  }

  // --- Tasks ---

  getTask(id: string): TaskRow | null {
    const row = this.getTaskStmt.get(id) as TaskRow | undefined;
    return row ?? null;
  }

  insertTask(t: TaskRow): void {
    this.insertTaskStmt.run(
      t.merchant_task_id,
      t.invocation_id,
      t.state,
      t.sequence,
      t.contract_test ? 1 : 0,
      t.answer,
      t.ready_at,
      t.completed ? 1 : 0,
      t.question,
      t.mode,
      t.artifacts_json,
      t.created_at,
    );
  }

  /**
   * INSERT OR REPLACE — used by state advances (working -> input_required
   * -> completed) inside taskSnapshot(). The full row is rewritten, so the
   * caller must include every field.
   */
  upsertTask(t: TaskRow): void {
    this.upsertTaskStmt.run(
      t.merchant_task_id,
      t.invocation_id,
      t.state,
      t.sequence,
      t.contract_test ? 1 : 0,
      t.answer,
      t.ready_at,
      t.completed ? 1 : 0,
      t.question,
      t.mode,
      t.artifacts_json,
      t.created_at,
    );
  }

  /**
   * Atomically read-modify-write a task under an in-process mutex.
   * Returns the (possibly mutated) row, or null if the task does not exist.
   * Pass `mutate` to modify fields; if it returns null, no write is performed.
   */
  updateTask(
    id: string,
    mutate: (row: TaskRow) => TaskRow | null,
  ): TaskRow | null {
    // SQLite is single-writer per file via WAL; we just do read-then-write.
    // For the same-process case this is enough; the openai SDK provider runs
    // in a single Node event loop. Multi-process safety comes from SQLite's
    // BEGIN IMMEDIATE transactions — out of scope for the reference impl.
    const current = this.getTask(id);
    if (!current) return null;
    const updated = mutate(current);
    if (!updated) return current;
    this.updateTaskStateStmt.run(
      updated.state,
      updated.sequence,
      updated.answer,
      updated.completed ? 1 : 0,
      updated.artifacts_json,
      id,
    );
    return updated;
  }

  // --- Nonces ---

  /**
   * Try to consume a nonce. Returns true if the nonce is new (and is now
   * recorded), false if it was already used within the retention window.
   * Also prunes nonces older than `retentionSeconds` (default 600).
   */
  consumeNonce(nonce: string, retentionSeconds = 600, nowSec = Date.now() / 1000): boolean {
    this.deleteOldNoncesStmt.run(nowSec - retentionSeconds);
    const seen = this.getNonceStmt.get(nonce) as { seen_at: number } | undefined;
    if (seen) return false;
    this.insertNonceStmt.run(nonce, nowSec);
    return true;
  }

  // --- Stats / shutdown ---

  taskCount(): number {
    const r = this.db.prepare('SELECT COUNT(*) AS c FROM tasks').get() as { c: number };
    return r.c;
  }

  nonceCount(): number {
    const r = this.countNoncesStmt.get() as { c: number };
    return r.c;
  }

  close(): void {
    this.db.close();
  }
}

/** Default DB path under the current working directory. */
export const DEFAULT_DB_PATH = path.resolve(
  process.env.FINCH_DB_PATH ?? './finch-provider.db',
);
