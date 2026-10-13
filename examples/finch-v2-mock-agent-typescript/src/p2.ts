/**
 * P2 / P3 async LLM driver.
 *
 * When an LLM is configured, P2 and P3 tasks no longer rely on the
 * deterministic 0.5s/0.6s timers in `taskSnapshot`. Instead, we kick
 * off an async runAgentTurn() after the task is persisted, and let the
 * agent decide whether to ask for clarification (P2 → input_required)
 * or provide a final answer (P2/P3 → completed).
 *
 * The platform's /tasks/{id} polling then surfaces the LLM-driven
 * state. The P2 supplemental input flow (`POST /tasks/{id}/messages`)
 * also routes through here — we append the user's reply to the
 * SQLite-backed message history and re-run the agent.
 *
 * Decide-response protocol:
 *   The model is given the `decide_response` tool alongside the
 *   built-ins. It returns either:
 *     { needs_clarification: true,  clarification_question: "..." }
 *     { needs_clarification: false, answer: "..." }
 *   If the model skips the tool and just returns text, we
 *   fall back to a heuristic: short text or a trailing `?` is
 *   treated as a clarification question, longer text as the
 *   final answer. (The tool call path is preferred — better
 *   structured output, less brittle.)
 *
 * Concurrency: the driver runs after `writeSignedTo(202)` returns, so
 * the platform's 202 reply is not blocked. Multiple polls during the
 * LLM call will see `state: 'working'`, which is correct.
 */

import { buildLlmHistory } from './history.ts';
import { createLlmProvider, type LlmConfig } from './llm.ts';
import { runAgentTurn } from './agent.ts';
import type { Store, TaskRow } from './db.ts';

export interface P2Decision {
  state: 'input_required' | 'completed';
  question?: string;
  answer?: string;
  /** Token usage for the LLM call that produced this decision. */
  usage: { input_tokens: number; output_tokens: number };
  /** How many agent steps it took. */
  steps: number;
}

const FALLBACK_QUESTION = '请补充说明你期望的具体安排(时间、范围或约束)。';

/**
 * Drive the agent on a single P2/P3 decision point.
 *
 * @param store    SQLite-backed store (the same one provider.ts uses).
 * @param taskId   merchant_task_id; the agent reads/writes history
 *                 rows under this id.
 * @param userText The new user turn. For first-touch P2 this is
 *                 `payload.input.content`; for supplemental it's the
 *                 message body of `POST /tasks/{id}/messages`.
 * @param cfg      LLM config (env-derived). `cfg.systemPrompt` is
 *                 REPLACED with a P2-specific system prompt that
 *                 explicitly tells the model to use `decide_response`.
 *                 The user's configured prompt is appended as a
 *                 `style:` line so brand voice is preserved.
 * @param onEvent  Optional callback for streaming UIs / logs.
 */
export async function runP2Decision(
  store: Store,
  taskId: string,
  userText: string,
  cfg: LlmConfig,
  onEvent?: Parameters<typeof runAgentTurn>[0]['onEvent'],
): Promise<P2Decision> {
  // Persist the user turn first so the agent's history includes it
  // if it's asked to look back across turns.
  if (userText) {
    store.appendMessage({ task_id: taskId, role: 'user', content: userText });
  }
  const history = buildLlmHistory(store, taskId, cfg.systemPrompt);

  // P2-specific system prompt: explicitly requires the decide_response
  // tool. Without this, models default to "I need more info" and we
  // can't tell that from a legitimate clarification request.
  const p2SystemPrompt = [
    'You are an agent finishing a merchant task on the Finch platform.',
    'You MUST respond by calling the `decide_response` tool with exactly one of:',
    '  { needs_clarification: true,  clarification_question: "<one short question>" }',
    '  { needs_clarification: false, answer: "<your final answer>" }',
    'Rules:',
    '  - If the user request is unambiguous AND you can answer it now, set needs_clarification=false.',
    '  - Only set needs_clarification=true if a specific detail is genuinely missing (date, location, scope).',
    '  - The clarification_question must be a single short question in the user\'s language.',
    '  - The answer must be a complete, useful reply — not a placeholder.',
    cfg.systemPrompt ? `\nStyle note: ${cfg.systemPrompt}` : '',
  ].filter(Boolean).join('\n');

  const llm = createLlmProvider(cfg);
  const resp = await runAgentTurn(
    {
      llm,
      systemPrompt: p2SystemPrompt,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      onEvent,
    },
    history,
    userText,
  );

  // Look for a decide_response tool call. The agent's tool result also
  // gets persisted so the next turn can see the full thread.
  let question: string | undefined;
  let answer: string | undefined;
  for (const tc of resp.toolCalls) {
    if (tc.name === 'decide_response') {
      let args: { needs_clarification?: boolean; clarification_question?: string; answer?: string } = {};
      try {
        const parsed: unknown = JSON.parse(JSON.stringify(tc.args));
        if (parsed && typeof parsed === 'object') args = parsed as typeof args;
      } catch { /* malformed tool call — fall through */ }
      if (args.needs_clarification) {
        question = (typeof args.clarification_question === 'string' && args.clarification_question)
          ? args.clarification_question
          : FALLBACK_QUESTION;
      } else {
        answer = (typeof args.answer === 'string') ? args.answer : '';
      }
      // Persist the tool result so the history reflects what happened.
      const resultPayload = args.needs_clarification
        ? { status: 'clarification_scheduled' }
        : { status: 'final_answer_recorded' };
      // Note: the per-turn `decide_response` tool_call was already
      // recorded in `messages` by the agent loop. We only need to add
      // the tool result row.
      // (We don't have the tool_call id from AgentResponse.toolCalls;
      //  it's only available on the LLM-visible ToolCall shape. Skip
      //  the per-tool persistence for decide_response — the assistant
      //  turn is enough for history continuity.)
    }
  }

  if (!question && !answer) {
    // Model skipped decide_response. Heuristic fallback.
    const text = (resp.text ?? '').trim();
    if (!text) {
      answer = '(empty reply)';
    } else if (text.length < 80 || /[?？]\s*$/.test(text)) {
      question = text;
    } else {
      answer = text;
    }
  }

  if (answer) {
    store.appendMessage({ task_id: taskId, role: 'assistant', content: answer });
  } else if (question) {
    store.appendMessage({ task_id: taskId, role: 'assistant', content: question });
  }

  return question
    ? { state: 'input_required', question, usage: resp.usage, steps: resp.steps }
    : { state: 'completed', answer: answer ?? '', usage: resp.usage, steps: resp.steps };
}

/**
 * Apply a P2 decision to the task row. Returns the updated task.
 * Idempotent: caller should be safe to retry on partial failure.
 */
export function applyP2Decision(task: TaskRow, decision: P2Decision): TaskRow {
  if (decision.state === 'input_required') {
    return {
      ...task,
      state: 'input_required',
      question: decision.question ?? FALLBACK_QUESTION,
      sequence: task.sequence + 1,
    };
  }
  return {
    ...task,
    state: 'completed',
    completed: true,
    answer: (decision.answer ?? '').slice(0, 1000),
    sequence: task.sequence + 1,
  };
}
