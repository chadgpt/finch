/**
 * Conversation history → LLM-visible ChatMessage conversion.
 *
 * This module is the single bridge between the SQLite-backed message log
 * (`Store.appendMessage` / `Store.getHistory`) and the `LlmProvider` request
 * shape (`ChatMessage[]`). Keeping the conversion in one place means callers
 * (the P1 streaming handler, the P2 supplemental-input handler, the
 * integration test) can all share the same "build the LLM history" logic
 * without duplicating the tool-in-flight / system-prompt / ordering rules.
 *
 * The module imports only TYPES from `./llm.ts` — no SDK code is pulled in.
 * That keeps the Deno `imports` map and the `openai` package dependency out
 * of any pure-history unit test.
 */

import type { Store } from './db.ts';
import type { ChatMessage, ToolCall } from './llm.ts';

/**
 * Build the LLM-visible message history for a task.
 *
 *   1. Pull every row in seq-ASC order via `Store.getHistory`.
 *   2. Prepend `systemPrompt` as a `system` message (idempotently — skip if
 *      a `system` message is already at the head, e.g. when persisting a
 *      follow-up turn that included its own system prompt).
 *   3. Drop `tool` messages that are "in flight" — i.e. their `tool_call_id`
 *      does not appear in any prior assistant turn's `tool_calls` array.
 *      These orphans would otherwise confuse the model (it never saw the
 *      tool request that produced them) and are usually leftovers from an
 *      aborted run.
 *   4. Map each surviving row to a `ChatMessage`:
 *        - `assistant` with `tool_calls`        → preserve `tool_calls`
 *        - `tool`                               → `{role:'tool', tool_call_id, name, content}`
 *        - everything else                      → `{role, content}`
 *
 * @param store         The SQLite-backed store.
 * @param taskId        The task to read history for. The caller decides the
 *                      wiring — for P1 a synthetic id is fine, for P2 it
 *                      is the merchant_task_id.
 * @param systemPrompt  System prompt to prepend. Empty string is allowed
 *                      and produces no system message.
 */
export function buildLlmHistory(
  store: Store,
  taskId: string,
  systemPrompt: string,
): ChatMessage[] {
  const rows = store.getHistory(taskId);

  // 1. Collect the set of tool_call_ids that an assistant turn has already
  //    requested. A `tool` message that references an id outside this set
  //    is "in flight" (no matching request) and gets dropped.
  const requestedIds = new Set<string>();
  for (const r of rows) {
    if (r.role === 'assistant' && r.tool_calls) {
      for (const tc of r.tool_calls) requestedIds.add(tc.id);
    }
  }

  // 2. Map surviving rows to ChatMessage.
  const out: ChatMessage[] = [];
  for (const r of rows) {
    if (r.role === 'tool') {
      if (!r.tool_call_id || !requestedIds.has(r.tool_call_id)) continue;
      out.push({
        role: 'tool',
        content: r.content,
        tool_call_id: r.tool_call_id,
        ...(r.name ? { name: r.name } : {}),
      });
      continue;
    }
    if (r.role === 'assistant') {
      const msg: ChatMessage = { role: 'assistant', content: r.content };
      if (r.tool_calls && r.tool_calls.length > 0) {
        msg.tool_calls = r.tool_calls;
      }
      out.push(msg);
      continue;
    }
    // user | anything else → just role + content
    out.push({ role: r.role, content: r.content });
  }

  // 3. Idempotently prepend the system prompt.
  if (systemPrompt) {
    const first = out[0];
    if (!first || first.role !== 'system' || first.content !== systemPrompt) {
      out.unshift({ role: 'system', content: systemPrompt });
    }
  }

  return out;
}

/**
 * Re-export the `ToolCall` type for callers that want to construct
 * `ChatMessage.tool_calls` payloads without pulling `llm.ts` themselves.
 */
export type { ToolCall };
