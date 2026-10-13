/**
 * Agent core — wraps an LlmProvider with tool-calling, multi-turn history,
 * and (optionally) SQLite persistence.
 *
 * Design:
 *   - The agent is intentionally protocol-agnostic. It does not know about
 *     finch_v2, P1/P2/P3, or the HMAC layer. The provider's HTTP handlers
 *     own that.
 *   - History is an in-memory `ChatMessage[]` at the call site. The provider
 *     may choose to back it with a Store (P2 multi-turn) or a stateless
 *     snapshot (P1 — pull from the protocol's `conversation.messages` field).
 *   - The agent drives a tool-calling loop up to `maxToolSteps` iterations.
 *     Each tool result is fed back as a `role: 'tool'` message, and the model
 *     is asked again. When the model returns plain text, the loop ends.
 *
 *   - Built-in tools (`BUILTIN_TOOLS`) are registered by default. Callers can
 *     pass extra tools via the `extraTools` parameter.
 *
 *   - The `onEvent` callback (optional) lets the HTTP handler stream partial
 *     text chunks to the client without coupling the agent to any transport.
 */

import type {
  ChatMessage,
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ToolCall,
  ToolSpec,
} from './llm.ts';
import { LlmError } from './llm.ts';
import { BUILTIN_TOOLS, executeBuiltinTool } from './llm.ts';

export interface AgentTool extends ToolSpec {
  /** Execute the tool. Throwing is allowed; the agent converts to a tool
   *  result message with `error: true`. */
  execute(args: Record<string, unknown>): Promise<unknown>;
}

export interface AgentDeps {
  llm: LlmProvider;
  /** System prompt. Prepended to every LLM call. */
  systemPrompt: string;
  /** Model id forwarded to the LlmProvider. */
  model: string;
  /** Max output tokens per LLM call. */
  maxTokens: number;
  /** Max tool-call loop iterations. Defaults to 5. */
  maxToolSteps?: number;
  /** Tools in addition to BUILTIN_TOOLS. Optional. */
  extraTools?: AgentTool[];
  /** Fires for every event the agent produces — text deltas, tool
   *  invocations, tool results, the final response. Used by TUI and
   *  streaming HTTP. Optional. */
  onEvent?: (ev: AgentEvent) => void;
}

export type AgentEvent =
  | { kind: 'text_delta'; text: string }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; ok: boolean; preview: string }
  | { kind: 'final'; response: AgentResponse };

export interface AgentResponse {
  /** Final assistant text (after all tool calls). */
  text: string;
  /** All tool calls the agent made in order. */
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  /** Total token usage across every LLM call. */
  usage: { input_tokens: number; output_tokens: number };
  /** How many LLM round-trips the loop took. */
  steps: number;
}

function mergeTools(extra: AgentTool[] | undefined): AgentTool[] {
  // BUILTIN_TOOLS is ToolSpec[]; wrap each with an execute() that calls
  // executeBuiltinTool. Extra tools are passed through as-is.
  const builtins: AgentTool[] = BUILTIN_TOOLS.map((spec) => ({
    ...spec,
    execute: async (args: Record<string, unknown>) => executeBuiltinTool(spec.function.name, args),
  }));
  return [...builtins, ...(extra ?? [])];
}

function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => {
    const { execute: _e, ...spec } = t;
    return spec;
  });
}

function findTool(tools: AgentTool[], name: string): AgentTool | undefined {
  return tools.find((t) => t.function.name === name);
}

function safeParseArgs(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return {};
  } catch {
    return {};
  }
}

function previewResult(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

/**
 * Drive the agent on a single user turn.
 *
 *   - `history` is the full message list BEFORE the new user turn.
 *     The caller is responsible for passing prior assistant / tool turns.
 *   - `userMessage` is the new user turn (text only; multimodal not supported
 *     by the protocol yet, and the LlmProvider ChatMessage shape is text).
 *
 * Returns the final AgentResponse. The agent's `onEvent` (if set) gets every
 * step streamed as it happens.
 */
export async function runAgentTurn(
  deps: AgentDeps,
  history: ChatMessage[],
  userMessage: string,
): Promise<AgentResponse> {
  const tools = mergeTools(deps.extraTools);
  const maxSteps = deps.maxToolSteps ?? 5;

  // Build working messages: system + history + new user turn
  const messages: ChatMessage[] = [...history];
  if (deps.systemPrompt) {
    const first = messages[0];
    if (!first || first.role !== 'system') {
      messages.unshift({ role: 'system', content: deps.systemPrompt });
    } else if (first.content !== deps.systemPrompt) {
      messages[0] = { role: 'system', content: deps.systemPrompt };
    }
  }
  if (userMessage) {
    messages.push({ role: 'user', content: userMessage });
  }

  const allToolCalls: AgentResponse['toolCalls'] = [];
  let totalUsage = { input_tokens: 0, output_tokens: 0 };
  let finalText = '';
  let steps = 0;

  for (let i = 0; i < maxSteps; i++) {
    steps++;
    const req: LlmRequest = {
      model: deps.model,
      messages,
      max_tokens: deps.maxTokens,
      ...(tools.length > 0 ? { tools: toolSpecs(tools) } : {}),
    };
    let resp: LlmResponse;
    try {
      resp = await deps.llm.complete(req);
    } catch (err) {
      // Re-throw LlmError as-is; wrap other errors.
      if (err instanceof LlmError) throw err;
      throw new LlmError('llm_error', err instanceof Error ? err.message : String(err));
    }
    totalUsage.input_tokens += resp.usage.input_tokens;
    totalUsage.output_tokens += resp.usage.output_tokens;

    // Stream text delta (always, even if we have tool calls — some UIs want it)
    if (resp.text) {
      deps.onEvent?.({ kind: 'text_delta', text: resp.text });
    }

    if (!resp.tool_calls || resp.tool_calls.length === 0) {
      finalText = resp.text;
      break;
    }

    // Append the assistant turn that requested the tools
    messages.push({
      role: 'assistant',
      content: resp.text,
      tool_calls: resp.tool_calls,
    });

    // Execute each tool and feed results back
    for (const tc of resp.tool_calls) {
      const name = tc.function.name;
      const args = safeParseArgs(tc.function.arguments);
      deps.onEvent?.({ kind: 'tool_call', name, args });
      let result: unknown;
      let ok = true;
      try {
        const tool = findTool(tools, name);
        if (!tool) {
          ok = false;
          result = { error: `unknown tool: ${name}` };
        } else {
          result = await tool.execute(args);
        }
      } catch (e) {
        ok = false;
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const preview = previewResult(result);
      deps.onEvent?.({ kind: 'tool_result', name, ok, preview });
      allToolCalls.push({ name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: tc.id,
        ...(name ? { name } : {}),
        content: typeof result === 'string' ? result : JSON.stringify(result),
      });
    }
    // Loop continues — the model now sees tool results.
  }

  if (!finalText && allToolCalls.length > 0) {
    // Hit max steps without a final text reply — synthesise a summary from
    // the last tool result so callers always get *something* sensible.
    const last = allToolCalls[allToolCalls.length - 1];
    if (last) {
      finalText = `[agent loop ended at ${steps} step(s); last tool result: ${
        typeof last.result === 'string' ? last.result : JSON.stringify(last.result)
      }]`;
    }
  }

  const response: AgentResponse = {
    text: finalText,
    toolCalls: allToolCalls,
    usage: totalUsage,
    steps,
  };
  deps.onEvent?.({ kind: 'final', response });
  return response;
}

// Re-export the built-in tool registry so callers don't need to import llm.ts
// for the common case.
export { BUILTIN_TOOLS, executeBuiltinTool };
export type { LlmProvider, LlmRequest, LlmResponse, ChatMessage, ToolCall, ToolSpec };
