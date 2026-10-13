/**
 * In-process tests for the messages history table + history conversion.
 *
 * Uses `node:test` (Node 22+ built-in, also supported by Deno 2.x). Each
 * test creates a fresh on-disk SQLite file under tmpdir, so runs are
 * isolated and parallel-safe.
 *
 * Coverage:
 *   1. `appendMessage` auto-assigns seq 0, 1, 2, ...
 *   2. `getHistory` returns rows in seq-ASC order
 *   3. Explicit `seq` collision throws a `MessageSeqConflictError`
 *   4. `buildLlmHistory` passes assistant `tool_calls` through to ChatMessage
 *   5. `buildLlmHistory` maps role='tool' rows to {role, tool_call_id, name, content}
 *
 * Bonus:
 *   6. `buildLlmHistory` strips in-flight tool messages (no matching request)
 *   7. `buildLlmHistory` idempotently prepends the system prompt
 *   8. `appendMessage` without `tool_calls` writes a NULL tool_calls column
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';
import { Store, type ToolCall, MessageSeqConflictError } from './db.ts';
import { buildLlmHistory } from './history.ts';
import type { ChatMessage } from './llm.ts';

function freshStorePath(label: string): string {
  return path.join(
    os.tmpdir(),
    `finch-history-${label}-${process.pid}-${Date.now()}-${randomBytes(4).toString('hex')}.db`,
  );
}

function cleanup(p: string): void {
  for (const suffix of ['', '-shm', '-wal']) {
    try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
  }
}

const toolCall: ToolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'get_weather', arguments: '{"city":"Beijing"}' },
};

const toolCall2: ToolCall = {
  id: 'call_2',
  type: 'function',
  function: { name: 'get_time', arguments: '{}' },
};

// 1) appendMessage auto-assigns seq 0, 1, 2, ...
test('appendMessage auto-assigns seq 0,1,2,... per task', () => {
  const dbPath = freshStorePath('auto-seq');
  const store = new Store(dbPath);
  try {
    const s0 = store.appendMessage({ task_id: 't1', role: 'user', content: 'hi' });
    const s1 = store.appendMessage({ task_id: 't1', role: 'assistant', content: 'hello' });
    const s2 = store.appendMessage({ task_id: 't1', role: 'user', content: 'again' });
    assert.equal(s0, 0);
    assert.equal(s1, 1);
    assert.equal(s2, 2);

    // Different task — starts at 0 independently.
    const t2s0 = store.appendMessage({ task_id: 't2', role: 'user', content: 'other' });
    assert.equal(t2s0, 0);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 2) getHistory returns rows in seq-ASC order
test('getHistory returns rows in seq-ASC order', () => {
  const dbPath = freshStorePath('order');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'first' });
    store.appendMessage({ task_id: 't1', role: 'assistant', content: 'second' });
    store.appendMessage({ task_id: 't1', role: 'user', content: 'third' });

    const hist = store.getHistory('t1');
    assert.equal(hist.length, 3);
    assert.deepEqual(
      hist.map((h) => h.content),
      ['first', 'second', 'third'],
    );
    assert.deepEqual(
      hist.map((h) => h.seq),
      [0, 1, 2],
    );

    // Empty history for unknown task.
    assert.deepEqual(store.getHistory('nope'), []);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 3) Duplicate (task_id, seq) → throw friendly MessageSeqConflictError
test('appendMessage throws MessageSeqConflictError on duplicate (task_id, seq)', () => {
  const dbPath = freshStorePath('conflict');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'a', seq: 0 });
    store.appendMessage({ task_id: 't1', role: 'user', content: 'b', seq: 1 });

    assert.throws(
      () => store.appendMessage({ task_id: 't1', role: 'user', content: 'c', seq: 0 }),
      (err: unknown) => {
        assert.ok(err instanceof MessageSeqConflictError, `expected MessageSeqConflictError, got ${err}`);
        assert.equal((err as MessageSeqConflictError).taskId, 't1');
        assert.equal((err as MessageSeqConflictError).seq, 0);
        return true;
      },
    );

    // The DB must still be usable after a rollback — auto-seq continues.
    const nextSeq = store.appendMessage({ task_id: 't1', role: 'user', content: 'd' });
    assert.equal(nextSeq, 2);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 4) buildLlmHistory maps assistant tool_calls through to ChatMessage
test('buildLlmHistory passes assistant tool_calls through to ChatMessage', () => {
  const dbPath = freshStorePath('toolcalls');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'weather?' });
    store.appendMessage({
      task_id: 't1',
      role: 'assistant',
      content: '',
      tool_calls: [toolCall, toolCall2],
    });
    store.appendMessage({ task_id: 't1', role: 'user', content: 'thanks' });

    const out = buildLlmHistory(store, 't1', 'be helpful');
    assert.equal(out.length, 4);
    // [0] system
    assert.equal(out[0]?.role, 'system');
    assert.equal(out[0]?.content, 'be helpful');
    // [1] user
    assert.equal(out[1]?.role, 'user');
    assert.equal(out[1]?.content, 'weather?');
    // [2] assistant with tool_calls
    const assistantMsg = out[2];
    assert.ok(assistantMsg, 'expected a message at index 2');
    assert.equal(assistantMsg.role, 'assistant');
    assert.equal(assistantMsg.content, '');
    assert.ok(Array.isArray(assistantMsg.tool_calls));
    assert.equal(assistantMsg.tool_calls?.length, 2);
    assert.equal(assistantMsg.tool_calls?.[0]?.id, 'call_1');
    assert.equal(assistantMsg.tool_calls?.[1]?.function.name, 'get_time');
    // [3] user
    assert.equal(out[3]?.role, 'user');
    assert.equal(out[3]?.content, 'thanks');
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 5) buildLlmHistory maps role='tool' → {role, tool_call_id, name, content}
test("buildLlmHistory maps role='tool' to {role,tool_call_id,name,content}", () => {
  const dbPath = freshStorePath('tool-role');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'weather?' });
    store.appendMessage({
      task_id: 't1',
      role: 'assistant',
      content: '',
      tool_calls: [toolCall],
    });
    store.appendMessage({
      task_id: 't1',
      role: 'tool',
      content: '{"temp":20}',
      tool_call_id: 'call_1',
      name: 'get_weather',
    });
    store.appendMessage({ task_id: 't1', role: 'assistant', content: 'It is 20C.' });

    const out = buildLlmHistory(store, 't1', '');
    // No system prompt, so 4 messages total.
    assert.equal(out.length, 4);
    const toolMsg = out[2];
    assert.ok(toolMsg, 'expected a tool message at index 2');
    assert.equal(toolMsg.role, 'tool');
    assert.equal(toolMsg.content, '{"temp":20}');
    assert.equal(toolMsg.tool_call_id, 'call_1');
    assert.equal(toolMsg.name, 'get_weather');
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 6) buildLlmHistory strips in-flight tool messages (no matching request)
test('buildLlmHistory strips in-flight tool messages (no matching request)', () => {
  const dbPath = freshStorePath('in-flight');
  const store = new Store(dbPath);
  try {
    // 'tool' message whose id has no preceding assistant tool_calls entry
    // should be dropped — this is the "in flight" case.
    store.appendMessage({ task_id: 't1', role: 'tool', content: 'orphan', tool_call_id: 'call_orphan', name: 'noop' });
    store.appendMessage({ task_id: 't1', role: 'user', content: 'hello' });
    store.appendMessage({ task_id: 't1', role: 'assistant', content: 'hi' });

    const out = buildLlmHistory(store, 't1', '');
    // orphan should be filtered; only the user + assistant remain.
    assert.equal(out.length, 2);
    assert.equal(out[0]?.role, 'user');
    assert.equal(out[1]?.role, 'assistant');
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 7) buildLlmHistory idempotently prepends the system prompt
test('buildLlmHistory idempotently prepends the system prompt', () => {
  const dbPath = freshStorePath('sysprompt');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'hi' });

    // First call: prepends.
    const out1 = buildLlmHistory(store, 't1', 'be concise');
    assert.equal(out1[0]?.role, 'system');
    assert.equal(out1[0]?.content, 'be concise');

    // Empty prompt → no system message.
    const out2 = buildLlmHistory(store, 't1', '');
    assert.notEqual(out2[0]?.role, 'system');
    assert.equal(out2[0]?.role, 'user');
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

// 8) appendMessage without tool_calls writes NULL
test('appendMessage without tool_calls stores null tool_calls column', () => {
  const dbPath = freshStorePath('null-tool');
  const store = new Store(dbPath);
  try {
    store.appendMessage({ task_id: 't1', role: 'user', content: 'hi' });
    const hist = store.getHistory('t1');
    assert.equal(hist[0]?.tool_calls, null);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});
