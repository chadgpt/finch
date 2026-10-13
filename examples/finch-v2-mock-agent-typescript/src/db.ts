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

/**
 * One tool call in an assistant turn. Mirrors the OpenAI chat-completions
 * `tool_calls[i]` shape. Persisted to SQLite as a JSON string in the
 * `tool_calls` column.
 */
export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** A row in the `messages` table. */
export interface MessageRow {
  id: number;
  task_id: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: string | null; // JSON-encoded ToolCall[]; null if none
  tool_call_id: string | null;
  name: string | null;
  created_at: number;
}

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
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id       TEXT    NOT NULL,
  seq           INTEGER NOT NULL,         -- 0, 1, 2, ... per task
  role          TEXT    NOT NULL,         -- user | assistant | tool
  content       TEXT    NOT NULL,
  tool_calls    TEXT,                     -- JSON array of ToolCall, NULL if none
  tool_call_id  TEXT,                     -- when role='tool', the call id this responds to
  name          TEXT,                     -- when role='tool', the function name
  created_at    REAL    NOT NULL,
  UNIQUE(task_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_nonces_seen_at ON nonces(seen_at);
CREATE INDEX IF NOT EXISTS idx_tasks_created_at ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, seq);
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
  private readonly appendMessageStmt;
  private readonly nextMessageSeqStmt;
  private readonly getHistoryStmt;

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
             artifacts_json = ?, question = ?
       WHERE merchant_task_id = ?
    `);
    this.getNonceStmt = this.db.prepare('SELECT seen_at FROM nonces WHERE nonce = ?');
    this.insertNonceStmt = this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, seen_at) VALUES (?, ?)');
    this.countNoncesStmt = this.db.prepare('SELECT COUNT(*) AS c FROM nonces');
    this.deleteOldNoncesStmt = this.db.prepare('DELETE FROM nonces WHERE seen_at < ?');

    // Messages: appendMessage uses INSERT OR ROLLBACK so a UNIQUE(task_id, seq)
    // collision surfaces as a SqliteError rather than silently replacing.
    // The store-level try/catch translates that into a friendlier error.
    this.appendMessageStmt = this.db.prepare(`
      INSERT OR ROLLBACK INTO messages
        (task_id, seq, role, content, tool_calls, tool_call_id, name, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.nextMessageSeqStmt = this.db.prepare(
      'SELECT COALESCE(MAX(seq) + 1, 0) AS s FROM messages WHERE task_id = ?',
    );
    this.getHistoryStmt = this.db.prepare(
      'SELECT * FROM messages WHERE task_id = ? ORDER BY seq ASC',
    );
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
      updated.question,
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

  // --- Messages (multi-turn conversation history) ---

  /**
   * Append a message to a task's history and return its assigned seq.
   * If `seq` is omitted, the next free seq for the task is used (max+1).
   *
   * The seq must be unique per (task_id, seq) — passing a colliding seq
   * throws a `MessageSeqConflictError` instead of silently replacing. The
   * caller can choose to use `appendMessage(..., { seq })` to write a
   * specific slot.
   */
  appendMessage(input: {
    task_id: string;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls?: ToolCall[];
    tool_call_id?: string;
    name?: string;
    seq?: number;
    created_at?: number;
  }): number {
    const opts = input as {
      task_id: string;
      role: 'user' | 'assistant' | 'tool';
      content: string;
      tool_calls?: ToolCall[];
      tool_call_id?: string;
      name?: string;
      seq?: number;
      created_at?: number;
    };
    const seq =
      typeof opts.seq === 'number'
        ? opts.seq
        : (this.nextMessageSeqStmt.get(opts.task_id) as { s: number }).s;
    const toolCallsJson =
      opts.tool_calls && opts.tool_calls.length > 0
        ? JSON.stringify(opts.tool_calls)
        : null;
    try {
      this.appendMessageStmt.run(
        opts.task_id,
        seq,
        opts.role,
        opts.content,
        toolCallsJson,
        opts.tool_call_id ?? null,
        opts.name ?? null,
        opts.created_at ?? Date.now() / 1000,
      );
    } catch (err) {
      if (isSeqConflict(err)) {
        throw new MessageSeqConflictError(
          opts.task_id,
          seq,
          `message seq ${seq} already exists for task ${opts.task_id}`,
        );
      }
      throw err;
    }
    return seq;
  }

  /**
   * Read all messages for a task, ordered by seq ASC. tool_calls is parsed
   * back to a `ToolCall[]` (null if the original message had none).
   */
  getHistory(taskId: string): Array<{
    seq: number;
    role: 'user' | 'assistant' | 'tool';
    content: string;
    tool_calls: ToolCall[] | null;
    tool_call_id: string | null;
    name: string | null;
  }> {
    const rows = this.getHistoryStmt.all(taskId) as unknown as MessageRow[];
    return rows.map((r) => ({
      seq: r.seq,
      role: r.role,
      content: r.content,
      tool_calls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : null,
      tool_call_id: r.tool_call_id,
      name: r.name,
    }));
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

/**
 * Thrown by `Store.appendMessage` when a (task_id, seq) pair already exists.
 * Carries the offending ids so callers can decide whether to retry with a
 * higher seq or surface the failure.
 */
export class MessageSeqConflictError extends Error {
  readonly taskId: string;
  readonly seq: number;
  constructor(taskId: string, seq: number, message: string) {
    super(message);
    this.name = 'MessageSeqConflictError';
    this.taskId = taskId;
    this.seq = seq;
  }
}

/**
 * Best-effort check whether a thrown error from `node:sqlite` is a UNIQUE
 * constraint violation on the messages table.
 *
 * `node:sqlite` wraps every SQLite error in a plain `Error` with:
 *   - `code:    'ERR_SQLITE_ERROR'`
 *   - `errcode: 2067`           (= SQLITE_CONSTRAINT_UNIQUE extended code)
 *   - `errstr:  'constraint failed'`
 *   - `message: 'UNIQUE constraint failed: messages.task_id, messages.seq'`
 *
 * Since `code` is identical for any SQLite error, we additionally require
 * the message to mention `messages.` so we don't misclassify a UNIQUE
 * collision on a different table.
 */
function isSeqConflict(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; errcode?: number; message?: string };
  if (e.code !== 'ERR_SQLITE_ERROR') return false;
  return typeof e.message === 'string' && /messages\./.test(e.message);
}
