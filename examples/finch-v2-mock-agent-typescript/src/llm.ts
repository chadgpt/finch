/**
 * Provider-agnostic LLM abstraction layer.
 *
 * One library, two wire formats: `@earendil-works/pi-ai` wraps OpenAI
 * Chat Completions, Anthropic Messages, Google Gemini, Bedrock, Mistral,
 * and OpenAI Responses under a single `Models` API. The `agw.k0s.io`
 * gateway speaks both OpenAI and Anthropic formats, so the same runtime
 * flips between them by picking which pi-ai API implementation to mount.
 *
 * Selection: `createLlmProvider(cfg)` returns an `LlmProvider` whose
 * `complete` and `stream` methods hit either format. Detection is
 * purely by `cfg.baseUrl` — no `pi-ai` types leak out.
 *
 * Error model: transport-level failures surface as `LlmTimeoutError`,
 * `LlmNetworkError`, `LlmApiError` so callers can switch on the
 * category without depending on pi-ai's stopReason enumeration.
 *
 * Cross-runtime: Node 22+ and Deno 2.x, both via the same file. Deno
 * resolves `@earendil-works/pi-ai` through `deno.json`'s import map;
 * Node through `package.json` + `node_modules`.
 */

import { createModels, createProvider, envApiKeyAuth } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';

// ============================================================
// Wire types (provider-agnostic) — what integration code sees
// ============================================================

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** OpenAI-style tool calls. Absent on plain text turns. */
  tool_calls?: ToolCall[];
  /** On role='tool', the id of the assistant tool call this answers. */
  tool_call_id?: string;
  /** On role='tool', the name of the tool that produced the result. */
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  /** `arguments` is the JSON string the model produced; parse before use. */
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema describing the function arguments. */
    parameters: Record<string, unknown>;
  };
}

export interface LlmRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  tools?: ToolSpec[];
  tool_choice?: 'auto' | { type: 'function'; function: { name: string } };
}

export interface LlmResponse {
  /** Text reply. Empty if the model only produced tool calls. */
  text: string;
  /** Tool calls the model wants the host to make. May be empty. */
  tool_calls: ToolCall[];
  /** Token usage for cost tracking. */
  usage: { input_tokens: number; output_tokens: number };
}

export interface LlmProvider {
  readonly name: 'openai' | 'anthropic';
  complete(req: LlmRequest): Promise<LlmResponse>;
  /** Async iterator over text chunks. Tool calls are NOT streamed —
   *  the caller should use `complete()` if they need structured
   *  function-calling, or call `complete()` first and only stream
   *  the final text portion. */
  stream(req: LlmRequest): AsyncIterable<string>;
}

// ============================================================
// LLM config (matches what the rest of the project reads from env)
// ============================================================

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  maxTokens: number;
  timeoutMs: number;
}

// ============================================================
// Errors
// ============================================================

/**
 * Base error class for LLM failures. Carries a stable `code` so callers
 * (e.g. provider.ts) can switch on the error category without depending
 * on pi-ai's stopReason enum.
 */
export class LlmError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

export class LlmTimeoutError extends LlmError {
  constructor(message: string) {
    super('llm_timeout', message);
    this.name = 'LlmTimeoutError';
  }
}

export class LlmNetworkError extends LlmError {
  constructor(message: string) {
    super('llm_network', message);
    this.name = 'LlmNetworkError';
  }
}

export class LlmApiError extends LlmError {
  constructor(public status: number, message: string) {
    super(`llm_${status}`, message);
    this.name = 'LlmApiError';
  }
}

// ============================================================
// pi-ai wrapper
// ============================================================

/**
 * Map our ChatMessage[] to pi-ai's `Message[]`. pi-ai uses a single
 * `Message` union with a `role` discriminator; tool messages carry
 * `toolCallId` and `toolName` instead of `tool_call_id` and `name`.
 *
 * Tools are attached to the system message as `toolsAdded` (see
 * utils/transcript.ts:getCurrentSystemMessage). If there is no system
 * message, we prepend an empty one to carry the tools.
 */
function toPiMessages(msgs: ChatMessage[], tools?: ToolSpec[]): unknown[] {
  const out: unknown[] = [];
  let toolsAttached = false;
  const toolAdditions = tools && tools.length > 0
    ? tools.map((t) => ({
        type: 'function' as const,
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }))
    : [];
  for (const m of msgs) {
    if (m.role === 'system') {
      const sysMsg: Record<string, unknown> = { role: 'system', content: m.content };
      if (!toolsAttached && toolAdditions.length > 0) {
        sysMsg.toolsAdded = toolAdditions;
        toolsAttached = true;
      }
      out.push(sysMsg);
      continue;
    }
    if (m.role === 'tool') {
      out.push({
        role: 'tool',
        content: m.content,
        toolCallId: m.tool_call_id,
        toolName: m.name,
      });
      continue;
    }
    if (m.role === 'assistant') {
      // pi-ai's transformMessages() calls .flatMap() on content — so it must
      // be an array of content blocks, not a raw string.
      const blocks: unknown[] = [];
      if (m.content) {
        blocks.push({ type: 'text', text: m.content });
      }
      const msg: Record<string, unknown> = { role: 'assistant', content: blocks };
      if (m.tool_calls && m.tool_calls.length > 0) {
        msg.toolCalls = m.tool_calls.map((tc) => ({
          type: 'toolCall',
          id: tc.id,
          name: tc.function.name,
          arguments: parseJsonObject(tc.function.arguments),
        }));
      }
      out.push(msg);
      continue;
    }
    // user
    out.push({ role: 'user', content: m.content });
  }
  if (!toolsAttached && toolAdditions.length > 0) {
    // No system message in the history — prepend a blank one carrying tools.
    out.unshift({ role: 'system', content: '', toolsAdded: toolAdditions });
  }
  return out;
}

function parseJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  return {};
}

function toPiTools(tools: ToolSpec[]): unknown[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    parameters: t.function.parameters,
  }));
}

function fromPiToolCall(tc: { id?: string; name?: string; arguments?: unknown }): ToolCall {
  return {
    id: tc.id ?? '',
    type: 'function',
    function: {
      name: tc.name ?? '',
      arguments: JSON.stringify(tc.arguments ?? {}),
    },
  };
}

// (overloads above need an explicit cast to unknown for pi-ai's strict types)

/** Classify pi-ai AssistantMessage.stopReason + errorMessage into one of our error types. */
function classifyError(stopReason: string, errorMessage: string | undefined): Error {
  const msg = errorMessage ?? stopReason;
  const lower = msg.toLowerCase();
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return new LlmTimeoutError(msg);
  }
  if (
    lower.includes('fetch failed') ||
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('network') ||
    lower.includes('socket hang up')
  ) {
    return new LlmNetworkError(msg);
  }
  // Try to extract an HTTP status from the message
  const m = /(\b[45]\d\d\b)/.exec(msg);
  if (m) {
    return new LlmApiError(parseInt(m[1]!, 10), msg);
  }
  return new LlmApiError(500, msg);
}

class PiAiProvider implements LlmProvider {
  readonly name: 'openai' | 'anthropic';
  private readonly models: ReturnType<typeof createModels>;
  private readonly providerId: string;
  private readonly modelId: string;
  private readonly apiKey: string;

  constructor(
    name: 'openai' | 'anthropic',
    models: ReturnType<typeof createModels>,
    providerId: string,
    modelId: string,
    apiKey: string,
  ) {
    this.name = name;
    this.models = models;
    this.providerId = providerId;
    this.modelId = modelId;
    this.apiKey = apiKey;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) {
      throw new Error(`pi-ai: model ${this.providerId}/${this.modelId} not registered`);
    }
    const ctx = {
      systemPrompt: undefined as string | undefined,
      messages: toPiMessages(req.messages, req.tools) as never,
    };
    const opts = {
      apiKey: this.apiKey,
      maxTokens: req.max_tokens,
    };
    // pi-ai's complete() returns AssistantMessage directly. Errors come back
    // as AssistantMessage with stopReason='error' + errorMessage.
    const result = await this.models.complete(model, ctx, opts);
    if (result.stopReason === 'error' || result.stopReason === 'aborted') {
      throw classifyError(result.stopReason, result.errorMessage);
    }
    const text = result.content
      .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const tool_calls: ToolCall[] = (result.content as readonly unknown[])
      .filter((b): b is { type: 'toolCall'; id: string; name: string; arguments: unknown } => {
        return (
          typeof b === 'object' &&
          b !== null &&
          (b as { type?: unknown }).type === 'toolCall'
        );
      })
      .map(fromPiToolCall);
    return {
      text,
      tool_calls,
      usage: {
        input_tokens: result.usage?.input ?? 0,
        output_tokens: result.usage?.output ?? 0,
      },
    };
  }

  async *stream(req: LlmRequest): AsyncIterable<string> {
    // pi-ai's stream() yields events; only text_delta events carry text.
    // We deliberately skip tool_call events (call complete() if you need
    // structured tool use). On any setup error we throw.
    const model = this.models.getModel(this.providerId, this.modelId);
    if (!model) {
      throw new Error(`pi-ai: model ${this.providerId}/${this.modelId} not registered`);
    }
    const ctx = {
      systemPrompt: undefined as string | undefined,
      messages: toPiMessages(req.messages, req.tools) as never,
    };
    const opts = {
      apiKey: this.apiKey,
      maxTokens: req.max_tokens,
    };
    const s = this.models.stream(model, ctx, opts);
    for await (const ev of s) {
      if (ev.type === 'text_delta') {
        yield (ev as { delta: string }).delta;
        continue;
      }
      if (ev.type === 'error') {
        const err = (ev as { reason: string; error: { errorMessage?: string } }).error;
        throw classifyError(ev.reason, err?.errorMessage);
      }
      // other event types: start, done, toolcall_*, thinking_* — skip
    }
  }
}

// ============================================================
// Factory
// ============================================================

/**
 * Build an LlmProvider. Detection is purely by `cfg.baseUrl`:
 *   - if it contains "/v1/messages" or "anthropic"  → Anthropic Messages API
 *   - otherwise                                      → OpenAI Chat Completions
 *
 * `agw.k0s.io` defaults to OpenAI; pass `LLM_BASE_URL=.../v1/messages` to
 * flip to Anthropic. Both share the same gateway, same auth.
 */
export function createLlmProvider(cfg: LlmConfig): LlmProvider {
  const isAnthropic = cfg.baseUrl.includes('/v1/messages') || /anthropic/i.test(cfg.baseUrl);
  const name: 'openai' | 'anthropic' = isAnthropic ? 'anthropic' : 'openai';
  const providerId = `agw-${name}`;
  const modelId = cfg.model;

  // The pi-ai API implementation: openai-completions or anthropic-messages
  // Each is a lazy loader: anthropicMessagesApi() / openaiCompletionsApi()
  // return an object with stream/streamSimple methods that dynamically
  // import their heavy implementation only on first use.
  const api = isAnthropic ? anthropicMessagesApi() : openAICompletionsApi();

  const provider = createProvider({
    id: providerId,
    // pi-ai expects auth as { apiKey: {name, resolve, login} }, not the
    // top-level shape that envApiKeyAuth returns. Wrap it.
    auth: { apiKey: envApiKeyAuth('Gateway', ['LLM_API_KEY']) },
    baseUrl: cfg.baseUrl,
    models: [
      {
        type: 'chat',
        id: modelId,
        name: modelId,
        api: isAnthropic ? 'anthropic-messages' : 'openai-completions',
        provider: providerId,
        baseUrl: cfg.baseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: cfg.maxTokens,
      },
    ],
    api,
  });
  const models = createModels();
  models.setProvider(provider);
  return new PiAiProvider(name, models, providerId, modelId, cfg.apiKey);
}

// ============================================================
// Built-in tools (used by integration / TUI)
// ============================================================

export const BUILTIN_TOOLS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_current_time',
      description: 'Return the current UTC time as ISO 8601 string.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'decide_response',
      description:
        'Return either a clarifying question or the final answer for an async task. ' +
        'The caller passes the user text in the system prompt; this tool returns ' +
        '{needs_clarification, clarification_question, answer}.',
      parameters: {
        type: 'object',
        properties: {
          needs_clarification: { type: 'boolean' },
          clarification_question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['needs_clarification'],
      },
    },
  },
];

/**
 * Execute a built-in tool by name. `decide_response` is a signal tool
 * (LLM only returns a structured value, no side effect), so it throws.
 */
export function executeBuiltinTool(name: string, _args: unknown): string {
  if (name === 'get_current_time') return new Date().toISOString();
  if (name === 'decide_response') {
    throw new Error('decide_response is a signal tool, not executable');
  }
  throw new Error(`Unknown built-in tool: ${name}`);
}
