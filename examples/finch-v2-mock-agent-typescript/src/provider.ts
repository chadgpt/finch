#!/usr/bin/env tsx
/**
 * Finch async-task mock agent — finch_v2 wire protocol (TypeScript / Node 22+).
 *
 * Behavior (per task):
 *   invoke (input.parameters.contract_test === true) -> accepted; poll sees completed quickly.
 *   invoke (normal)                                  -> accepted; first poll returns
 *                                                      input_required with one question;
 *                                                      POST /tasks/{id}/messages flips the
 *                                                      task to completed and the final message
 *                                                      echoes the buyer's answer.
 *
 * All responses are HMAC-SHA256 signed with the request secret:
 *   canonical = METHOD\nPATH?QUERY\nTIMESTAMP\nNONCE\sha256(body)
 *   signature = "v1=" + hex(HMAC-SHA256(secret, canonical))
 *
 * Incoming platform requests are verified via the X-Platform-* headers; responses carry
 * X-Agent-* headers. Wire protocol: finch_v2 — Base64URL-decoded 32-byte secrets.
 *
 * Limitations (intentional, same as the official Python mock):
 *   - Does not send callbacks to Finch (provider-owned delivery policy).
 *   - Cancel handler is not a complete terminal-state implementation.
 *   - P3 upload is permissive (falls back to text/plain). Not safe for production.
 *   - Does not fully validate incoming protocol schemas.
 *
 * State (tasks, nonces) is persisted to a local SQLite file via the built-in
 * `node:sqlite` module — no Redis, no native deps, available in both
 * Node 22.5+ and Deno 2.x. The file path defaults to ./finch-provider.db.
 *
 * This file is structured 1:1 with the official Python mock so each block has an
 * obvious correspondence.
 */

import {
  createHmac,
  createHash,
  randomUUID,
  timingSafeEqual,
  type Hash,
} from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { request as httpRequest } from 'node:http';
import process from 'node:process';
import { Store, type TaskRow } from './db.ts';

// Note: `URL` is a global in both Node 22+ and Deno 2.x, so we use the global
// form here for cross-runtime compatibility.

// ============================================================
// Cross-runtime env helper
// ============================================================
// Works in both Node 22+ and Deno 2.x. Deno requires --allow-env to read
// process.env (provided by the node:process shim).
function env(name: string, fallback?: string): string | undefined {
  return process.env[name] ?? fallback;
}

// ============================================================
// Type definitions
// ============================================================

type InteractionMode = 'conversation_turn' | 'task' | 'generation';

type TaskStatus =
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

interface ContentPart {
  type: 'text';
  text: string;
}

interface Message {
  role: 'user' | 'agent';
  content: ContentPart[];
}

interface ArtifactUploadSlot {
  slot_id: string;
  asset_id: string;
  put_url: string;
  allowed_media_types: string[];
  max_bytes: number;
  expected_kind?: string;
  expires_at: string;
}

interface ArtifactRef {
  slot_id: string;
  asset_id: string;
  sha256: string;
  bytes: number;
  filename: string;
}

/** Minimal shape of a finch_v2 invocation body the mock actually reads. */
interface FinchV2Invocation {
  protocol_version: '2.0';
  invocation_id: string;
  interaction_mode: InteractionMode;
  input: {
    content: ContentPart[];
    parameters?: { contract_test?: boolean };
  };
  conversation?: {
    messages: Message[];
  };
  artifact_uploads?: ArtifactUploadSlot[];
}

/** Minimal shape of a P2 supplemental input body. */
interface FinchV2SupplementalInput {
  protocol_version: '2.0';
  task_id: string;
  message: Message;
}

interface AcceptedResponse {
  protocol_version: '2.0';
  invocation_id: string;
  status: 'accepted';
  merchant_task_id: string;
  poll_after_ms: number;
}

interface CompletedResponse {
  protocol_version: '2.0';
  invocation_id: string;
  status: 'completed';
  message: {
    role: 'agent';
    content: ContentPart[];
  };
  artifacts: ArtifactRef[];
  completed_at: string;
}

interface InputRequiredResponse {
  protocol_version: '2.0';
  invocation_id: string;
  status: 'input_required';
  questions: Array<{ id: string; question: string }>;
}

interface TaskSnapshot {
  protocol_version: '2.0';
  merchant_task_id: string;
  status: TaskStatus;
  sequence: number;
  progress?: { percent: number; stage: string };
  message?: { role: 'agent'; content: ContentPart[] };
  artifacts?: ArtifactRef[];
  questions?: Array<{ id: string; question: string }>;
  completed_at?: string;
}

// All task state is now stored in SQLite (see ./db.ts TaskRow).
// The local `Task` interface has been removed; everything reads/writes
// TaskRow directly.

// ============================================================
// Configuration (env-driven; same names as the Python mock)
// ============================================================

function loadSecret(envReader: (n: string, f?: string) => string | undefined, name: string, fallback?: string): Buffer {
  const raw = envReader(name, fallback);
  if (!raw) {
    throw new Error(`FATAL: ${name} is required (Base64URL encoding of 32 raw bytes)`);
  }
  const buf = Buffer.from(raw, 'base64url');
  if (buf.length !== 32) {
    throw new Error(`FATAL: ${name} must decode to 32 bytes, got ${buf.length}`);
  }
  return buf;
}

export interface ProviderConfig {
  requestSecret: Buffer;
  callbackSecret: Buffer;
  keyId: string;
  port: number;
  agentName: string;
  debugSign: boolean;
  /**
   * Path to the SQLite database file. State (tasks, nonces) persists across
   * restarts. Defaults to ./finch-provider.db if omitted.
   */
  dbPath?: string;
  /** Optional OpenAI-compatible LLM backend for P1 conversation. */
  llm?: LlmConfig;
}

export interface LlmConfig {
  /** Base URL, e.g. https://agw.k0s.io — code will append /v1/chat/completions. */
  baseUrl: string;
  /** API key; pass the literal "-" if the gateway accepts a sentinel. */
  apiKey: string;
  /** Model id, e.g. "MiniMax-M3" or "minimax-china/MiniMax-M3". */
  model: string;
  /** Optional system prompt prepended to every conversation. */
  systemPrompt?: string;
  /** Max tokens for the LLM response. Default 1024. */
  maxTokens?: number;
  /** Request timeout in ms. Default 30000. */
  timeoutMs?: number;
}

/**
 * Read configuration from a given env-reader. Allows tests to inject
 * a custom env without polluting the parent process. Same env-var names
 * as the Python mock.
 *
 * If LLM_BASE_URL is set (default: https://agw.k0s.io), the provider will
 * call a real OpenAI-compatible LLM for P1 conversation_turn turns. The
 * test harness can pass an empty/undefined llm block to disable this and
 * keep the original echo behavior.
 */
export function readConfig(
  envReader: (n: string, f?: string) => string | undefined = (n, f) => env(n, f),
): ProviderConfig {
  const baseUrl = envReader('LLM_BASE_URL') ?? 'https://agw.k0s.io';
  const cfg: ProviderConfig = {
    requestSecret: loadSecret(envReader, 'MOCK_REQUEST_SECRET'),
    callbackSecret: loadSecret(envReader, 'MOCK_CALLBACK_SECRET', envReader('MOCK_REQUEST_SECRET')),
    keyId: envReader('MOCK_KEY_ID') ?? '',
    port: parseInt(envReader('MOCK_PORT') ?? '28891', 10),
    agentName: envReader('MOCK_AGENT_NAME') ?? 'finch-async-mock-ts',
    debugSign: envReader('DEBUG_SIGN') === '1',
  };
  // Enable LLM by default — Finch providers are expected to be real Agents.
  // The test harness overrides this with a `llm: undefined` config.
  const apiKey = envReader('LLM_API_KEY') ?? '-';
  const model = envReader('LLM_MODEL') ?? 'MiniMax-M3';
  cfg.llm = {
    baseUrl,
    apiKey,
    model,
    systemPrompt: envReader('LLM_SYSTEM_PROMPT') ?? 'You are a helpful agent. Be concise.',
    maxTokens: parseInt(envReader('LLM_MAX_TOKENS') ?? '1024', 10),
    timeoutMs: parseInt(envReader('LLM_TIMEOUT_MS') ?? '30000', 10),
  };
  cfg.dbPath = envReader('FINCH_DB_PATH') ?? './finch-provider.db';
  return cfg;
}

// ============================================================
// Runtime config — initialized by startServer()
// ============================================================
// All helper functions read from this single `config` object. The test
// harness calls startServer() with its own config; the CLI entry point
// calls startServer() with a config built from env vars.
let config: ProviderConfig;
let store: Store | null = null;

// ============================================================
// Crypto primitives (canonical string + HMAC-SHA256)
// ============================================================

// ============================================================
// Crypto primitives (canonical string + HMAC-SHA256)
// ============================================================

function sha256Hex(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function sign(
  secret: Buffer,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const canonical = [
    method.toUpperCase(),
    path,
    timestamp,
    nonce,
    sha256Hex(body),
  ].join('\n');
  return 'v1=' + createHmac('sha256', secret).update(canonical).digest('hex');
}

function safeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// ============================================================
// ============================================================
// State (SQLite via node:sqlite) — see ./db.ts
// ============================================================
// All state is read/written through the `store` global, which is initialized
// in startServer(). Tests pass a per-run temp file; CLI passes a persistent
// file at ./finch-provider.db (or $FINCH_DB_PATH).

const SKEW_TOLERANCE_SEC = 300;
const NONCE_TTL_SEC = 600;

function consumeNonce(nonce: string): boolean {
  if (!store) throw new Error('store not initialized');
  return store.consumeNonce(nonce, NONCE_TTL_SEC);
}

function makeMerchantTaskId(invocationId: string, idempotencyKey: string): string {
  const h = createHash('sha256')
    .update(`${invocationId}:${idempotencyKey}`)
    .digest('hex');
  return 'mtk-' + h.slice(0, 24);
}

// ============================================================
// HTTP helpers
// ============================================================

async function readBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<Buffer> {
  // Use Content-Length as a sanity check (if present), but always read all chunks.
  // Returning early on length=0 is wrong: the client may use Transfer-Encoding: chunked
  // or omit Content-Length, in which case for-await is the only way to read the body.
  const lengthHeader = req.headers['content-length'];
  if (lengthHeader !== undefined) {
    const length = parseInt(Array.isArray(lengthHeader) ? lengthHeader[0] ?? '' : lengthHeader, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new Error('body_too_large');
    }
  }
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    const c = chunk as Buffer;
    received += c.length;
    if (received > maxBytes) throw new Error('body_too_large');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function pathWithQuery(req: IncomingMessage): string {
  const u = new URL(req.url ?? '/', 'http://localhost');
  return u.pathname + u.search;
}

// Simpler form: caller passes the ServerResponse directly.
function writeSignedTo(
  res: ServerResponse,
  req: IncomingMessage,
  status: number,
  payload: unknown,
): void {
  const raw = Buffer.from(JSON.stringify(payload));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().replace(/-/g, '');
  const sig = sign(
    config.requestSecret,
    req.method ?? 'GET',
    pathWithQuery(req),
    timestamp,
    nonce,
    raw,
  );
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': String(raw.length),
    'Cache-Control': 'no-store',
    'X-Agent-Key-Id': config.keyId,
    'X-Agent-Timestamp': timestamp,
    'X-Agent-Nonce': nonce,
    'X-Agent-Signature': sig,
  });
  res.end(raw);
}

function deny(res: ServerResponse, req: IncomingMessage): void {
  writeSignedTo(res, req, 401, { code: 'auth_failed' });
}

// ============================================================
// Inbound verification (Finch → Provider)
// ============================================================

async function verifyPlatform(req: IncomingMessage, body: Buffer): Promise<boolean> {
  const ts = req.headers['x-platform-timestamp'];
  const nonce = req.headers['x-platform-nonce'];
  const sig = req.headers['x-platform-signature'];
  if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
    if (config.debugSign) {
      console.error('verify: missing or wrong-type headers', { ts, nonce, sig: typeof sig });
    }
    return false;
  }
  const tsNum = parseInt(ts, 10);
  if (!Number.isFinite(tsNum)) {
    if (config.debugSign) console.error('verify: bad ts', ts);
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - tsNum) > SKEW_TOLERANCE_SEC) {
    if (config.debugSign) console.error('verify: skew', { now, tsNum, diff: now - tsNum });
    return false;
  }
  if (!nonce) {
    if (config.debugSign) console.error('verify: empty nonce');
    return false;
  }
  // Replay check (must happen BEFORE signature check; mocked Python does it inline)
  if (!consumeNonce(nonce)) {
    // Replay — return 409 with signed body. We need res from caller, so this is
    // signalled by returning 'replay' and letting the handler respond.
    throw new VerificationRejection('nonce_replay', 409);
  }
  const expected = sign(
    config.requestSecret,
    req.method ?? 'GET',
    pathWithQuery(req),
    ts,
    nonce,
    body,
  );
  if (!safeEq(expected, sig)) {
    if (config.debugSign) {
      console.error('verify: sig mismatch', {
        method: req.method,
        path: pathWithQuery(req),
        ts,
        nonce,
        bodyLen: body.length,
        bodySha256: sha256Hex(body),
        expected: expected.slice(0, 16) + '...',
        got: sig.slice(0, 16) + '...',
      });
    }
    return false;
  }
  return true;
}

class VerificationRejection extends Error {
  constructor(public code: string, public status: number) {
    super(code);
  }
}

// ============================================================
// LLM client
// ============================================================
// All LLM calls go through the provider-agnostic abstraction in ./llm.ts.
// That module picks between the OpenAI-compatible SDK and the Anthropic
// SDK based on `cfg.baseUrl`, and maps SDK-specific errors to a small
// set of provider-agnostic error classes (`LlmTimeoutError`,
// `LlmNetworkError`, `LlmApiError`, plus the base `LlmError`).
//
// We keep a per-server singleton: readConfig() builds an LlmConfig from
// env vars once, and every /invoke handler routes through the same
// `LlmProvider` instance.

import {
  createLlmProvider,
  LlmError,
  type LlmProvider,
} from './llm.ts';
import { runAgentTurn } from './agent.ts';

let _llmProvider: LlmProvider | null = null;
let _llmProviderConfig: LlmConfig | null = null;

function llmProvider(llm: LlmConfig): LlmProvider {
  if (_llmProvider && _llmProviderConfig === llm) return _llmProvider;
  // Materialize the optional fields with defaults before handing to pi-ai
  const normalized = {
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    systemPrompt: llm.systemPrompt ?? 'You are a helpful agent. Be concise.',
    maxTokens: llm.maxTokens ?? 1024,
    timeoutMs: llm.timeoutMs ?? 30000,
  };
  _llmProvider = createLlmProvider(normalized);
  _llmProviderConfig = llm;
  return _llmProvider;
}

// ============================================================
// Handlers
// ============================================================

async function handleHealth(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    if (!(await verifyPlatform(req, Buffer.alloc(0)))) {
      deny(res, req);
      return;
    }
  } catch (e) {
    if (e instanceof VerificationRejection) {
      writeSignedTo(res, req, e.status, { code: e.code });
      return;
    }
    throw e;
  }
  writeSignedTo(res, req, 200, { status: 'ready', service: config.agentName });
}

async function handleInvoke(
  res: ServerResponse,
  req: IncomingMessage,
  body: Buffer,
): Promise<void> {
  try {
    if (!(await verifyPlatform(req, body))) {
      deny(res, req);
      return;
    }
  } catch (e) {
    if (e instanceof VerificationRejection) {
      writeSignedTo(res, req, e.status, { code: e.code });
      return;
    }
    throw e;
  }

  let payload: FinchV2Invocation;
  try {
    payload = JSON.parse(body.toString('utf8') || '{}') as FinchV2Invocation;
  } catch {
    writeSignedTo(res, req, 422, { code: 'request_rejected' });
    return;
  }

  const invocationId = payload.invocation_id;
  if (typeof invocationId !== 'string' || !invocationId) {
    writeSignedTo(res, req, 422, { code: 'invocation_invalid' });
    return;
  }
  const mode = payload.interaction_mode;
  if (mode !== 'conversation_turn' && mode !== 'task' && mode !== 'generation') {
    writeSignedTo(res, req, 422, { code: 'interaction_mode_invalid' });
    return;
  }

  if (mode === 'conversation_turn') {
    // P1 — synchronous. If an LLM backend is configured, call it; otherwise
    // fall back to the deterministic echo behavior used by the test harness.
    const messages = payload.conversation?.messages ?? [];
    let visible = '';
    if (messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last) {
        for (const part of last.content) {
          if (part.type === 'text') visible = part.text;
        }
      }
    }
    // Also pick up the latest standalone input.content for the current turn.
    const inputParts = payload.input?.content ?? [];
    for (const part of inputParts) {
      if (part.type === 'text' && part.text) visible = part.text;
    }

    if (config.llm) {
      try {
        const provider = llmProvider(config.llm);
        // Convert protocol conversation history → LLM ChatMessage[]
        const historyMsgs: Array<{role:'user'|'assistant'|'system'; content:string}> = [];
        for (const m of payload.conversation?.messages ?? []) {
          const text = m.content
            .filter((p) => p.type === 'text')
            .map((p) => p.text)
            .join('\n');
          if (!text) continue;
          // protocol uses 'agent' for assistant turns
          historyMsgs.push({ role: m.role === 'agent' ? 'assistant' : 'user', content: text });
        }
        // Append the current user turn from input.content (visible takes
        // priority since conversation may not include it).
        if (visible && !historyMsgs.some((m) => m.content === visible)) {
          historyMsgs.push({ role: 'user', content: visible });
        }
        const agentResp = await runAgentTurn(
          {
            llm: provider,
            systemPrompt: config.llm.systemPrompt ?? 'You are a helpful agent. Be concise.',
            model: config.llm.model,
            maxTokens: config.llm.maxTokens ?? 1024,
          },
          historyMsgs,
          visible,
        );
        if (!agentResp.text) {
          throw new LlmError('llm_empty', 'LLM returned no text content');
        }
        const completed: CompletedResponse = {
          protocol_version: '2.0',
          invocation_id: invocationId,
          status: 'completed',
          message: {
            role: 'agent',
            content: [{ type: 'text', text: agentResp.text }],
          },
          artifacts: [],
          completed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        };
        writeSignedTo(res, req, 200, completed);
      } catch (err) {
        const code = err instanceof LlmError ? err.code : 'llm_error';
        const message = err instanceof Error ? err.message : String(err);
        writeSignedTo(res, req, 200, {
          protocol_version: '2.0',
          invocation_id: invocationId,
          status: 'failed',
          error: { code, message },
        });
      }
      return;
    }

    // Fallback: deterministic echo (used by the test harness).
    const completed: CompletedResponse = {
      protocol_version: '2.0',
      invocation_id: invocationId,
      status: 'completed',
      message: {
        role: 'agent',
        content: [{ type: 'text', text: `P1 mock 已完成:${visible}` }],
      },
      artifacts: [],
      completed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
    };
    writeSignedTo(res, req, 200, completed);
    return;
  }

  // P2 / P3 — async with deterministic merchant_task_id
  const idempotencyKey = (req.headers['idempotency-key'] as string) ?? '';
  const merchantTaskId = makeMerchantTaskId(invocationId, idempotencyKey);
  const parameters = payload.input?.parameters ?? {};
  const contractTest = parameters.contract_test === true;

  if (!store) throw new Error('store not initialized');

  // Idempotency: same invocation_id + same Idempotency-Key -> same task.
  const existing = store.getTask(merchantTaskId);
  if (existing) {
    // Replay: return the persisted accepted envelope.
    writeSignedTo(res, req, 202, {
      protocol_version: '2.0',
      invocation_id: existing.invocation_id,
      status: 'accepted',
      merchant_task_id: merchantTaskId,
      poll_after_ms: 500,
    });
    return;
  }

  const task: TaskRow = {
    merchant_task_id: merchantTaskId,
    invocation_id: invocationId,
    state: 'working',
    sequence: 1,
    contract_test: contractTest,
    answer: null,
    ready_at: Date.now() / 1000 + (contractTest ? 0.6 : 0.5),
    completed: false,
    question: '请补充说明你期望的具体安排(时间、范围或约束)。',
    mode,
    artifacts_json: '[]',
    created_at: Date.now() / 1000,
  };

  // P3 only: upload artifacts before persisting the task.
  if (mode === 'generation') {
    const slots = payload.artifact_uploads ?? [];
    const artifacts = await uploadSlots(slots);
    task.artifacts_json = JSON.stringify(artifacts);
  }

  store.insertTask(task);

  writeSignedTo(res, req, 202, {
    protocol_version: '2.0',
    invocation_id: invocationId,
    status: 'accepted',
    merchant_task_id: merchantTaskId,
    poll_after_ms: 500,
  });
}

async function uploadSlots(slots: ArtifactUploadSlot[]): Promise<ArtifactRef[]> {
  const out: ArtifactRef[] = [];
  const content = Buffer.from('Finch P3 mock generated artifact.\n', 'utf8');
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    if (!slot) continue;
    const allowed = slot.allowed_media_types ?? [];
    const mediaType = allowed.includes('text/plain')
      ? 'text/plain'
      : (allowed[0] ?? 'application/octet-stream');
    try {
      const ok = await new Promise<boolean>((resolve) => {
        const r = httpRequest(
          slot.put_url,
          {
            method: 'PUT',
            headers: {
              'Content-Type': mediaType,
              'X-Finch-Artifact-Filename': `finch-p3-mock-${i + 1}.txt`,
            },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
          },
        );
        r.on('error', () => resolve(false));
        r.end(content);
      });
      if (!ok) continue;
    } catch (err) {
      console.error(`P3 artifact upload failed: ${err}`);
      continue;
    }
    out.push({
      slot_id: slot.slot_id,
      asset_id: slot.asset_id,
      sha256: sha256Hex(content),
      bytes: content.length,
      filename: `finch-p3-mock-${i + 1}.txt`,
    });
  }
  return out;
}

function taskSnapshot(task: TaskRow): TaskSnapshot {
  const common = {
    protocol_version: '2.0' as const,
    merchant_task_id: task.merchant_task_id,
  };
  const artifacts: ArtifactRef[] = JSON.parse(task.artifacts_json) as ArtifactRef[];
  if (task.completed) {
    const answerText = task.answer ?? '(无补充)';
    if (task.mode === 'generation') {
      return {
        ...common,
        status: 'completed',
        sequence: task.sequence,
        completed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        message: {
          role: 'agent',
          content: [{ type: 'text', text: 'P3 mock 已完成生成。' }],
        },
        artifacts,
      };
    }
    return {
      ...common,
      status: 'completed',
      sequence: task.sequence,
      completed_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      message: {
        role: 'agent',
        content: [
          { type: 'text', text: `已收到你的补充说明:「${answerText}」。任务已完成。` },
        ],
      },
      artifacts: [],
    };
  }
  const now = Date.now() / 1000;
  if (task.state === 'input_required') {
    return {
      ...common,
      status: 'input_required',
      sequence: task.sequence,
      questions: [{ id: 'detail', question: task.question }],
    };
  }
  // Working state: check if ready_at has elapsed and advance.
  if (now >= task.ready_at) {
    if (!store) throw new Error('store not initialized');
    if (task.contract_test || task.mode === 'generation') {
      const completed: TaskRow = {
        ...task,
        completed: true,
        sequence: task.sequence + 1,
      };
      store.upsertTask(completed);
      return taskSnapshot(completed);
    }
    const advanced: TaskRow = {
      ...task,
      state: 'input_required',
      sequence: task.sequence + 1,
    };
    store.upsertTask(advanced);
    return {
      ...common,
      status: 'input_required',
      sequence: advanced.sequence,
      questions: [{ id: 'detail', question: advanced.question }],
    };
  }
  return {
    ...common,
    status: 'working',
    sequence: task.sequence,
    progress: { percent: 10, stage: 'clarifying' },
  };
}

async function handlePoll(
  res: ServerResponse,
  req: IncomingMessage,
  taskId: string,
): Promise<void> {
  try {
    if (!(await verifyPlatform(req, Buffer.alloc(0)))) {
      deny(res, req);
      return;
    }
  } catch (e) {
    if (e instanceof VerificationRejection) {
      writeSignedTo(res, req, e.status, { code: e.code });
      return;
    }
    throw e;
  }

  if (!store) throw new Error('store not initialized');
  const task = store.getTask(taskId);
  if (!task) {
    writeSignedTo(res, req, 404, { code: 'task_not_found' });
    return;
  }
  const snap = taskSnapshot(task);
  writeSignedTo(res, req, 200, snap);
}

async function handleMessages(
  res: ServerResponse,
  req: IncomingMessage,
  taskId: string,
  body: Buffer,
): Promise<void> {
  try {
    if (!(await verifyPlatform(req, body))) {
      deny(res, req);
      return;
    }
  } catch (e) {
    if (e instanceof VerificationRejection) {
      writeSignedTo(res, req, e.status, { code: e.code });
      return;
    }
    throw e;
  }

  let payload: FinchV2SupplementalInput;
  try {
    payload = JSON.parse(body.toString('utf8') || '{}') as FinchV2SupplementalInput;
  } catch {
    writeSignedTo(res, req, 422, { code: 'request_rejected' });
    return;
  }

  if (!store) throw new Error('store not initialized');
  let responseStatus = 200;
  let responseBody: unknown = { code: 'unknown' };
  store.updateTask(taskId, (task) => {
    if (!task) {
      responseStatus = 404;
      responseBody = { code: 'task_not_found' };
      return null;
    }
    if (task.completed || task.state !== 'input_required') {
      responseStatus = 409;
      responseBody = { code: 'task_not_awaiting_input' };
      return null;
    }
    let answer = '';
    for (const part of payload.message?.content ?? []) {
      if (part.type === 'text') {
        answer = (answer + ' ' + part.text).trim();
      }
    }
    const updated: TaskRow = {
      ...task,
      answer: answer.slice(0, 500),
      completed: true,
      sequence: task.sequence + 1,
    };
    responseStatus = 202;
    responseBody = {
      protocol_version: '2.0',
      status: 'accepted',
      merchant_task_id: taskId,
    };
    return updated;
  });
  writeSignedTo(res, req, responseStatus, responseBody);
}

async function handleCancel(
  res: ServerResponse,
  req: IncomingMessage,
  taskId: string,
  body: Buffer,
): Promise<void> {
  try {
    if (!(await verifyPlatform(req, body))) {
      deny(res, req);
      return;
    }
  } catch (e) {
    if (e instanceof VerificationRejection) {
      writeSignedTo(res, req, e.status, { code: e.code });
      return;
    }
    throw e;
  }

  if (!store) throw new Error('store not initialized');
  let responseStatus = 200;
  let responseBody: unknown = { code: 'unknown' };
  store.updateTask(taskId, (task) => {
    if (!task) {
      responseStatus = 404;
      responseBody = { code: 'task_not_found' };
      return null;
    }
    if (task.completed) {
      responseStatus = 409;
      responseBody = { code: 'task_terminal' };
      return null;
    }
    const updated: TaskRow = {
      ...task,
      completed: true,
      sequence: task.sequence + 1,
    };
    responseStatus = 200;
    responseBody = {
      protocol_version: '2.0',
      status: 'canceled',
      merchant_task_id: taskId,
      sequence: updated.sequence,
    };
    return updated;
  });
  writeSignedTo(res, req, responseStatus, responseBody);
}

// ============================================================
// Router
// ============================================================

function buildServer(): import('node:http').Server {
  return createServer(async (req, res) => {
  const method = req.method ?? 'GET';
  const pathOnly = (() => {
    try {
      return new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return '/';
    }
  })();

  try {
    if (method === 'GET' && pathOnly === '/health') {
      await handleHealth(res, req);
      return;
    }
    if (method === 'GET' && pathOnly.startsWith('/tasks/')) {
      const taskId = pathOnly.replace(/\/$/, '').split('/').pop() ?? '';
      await handlePoll(res, req, taskId);
      return;
    }
    if (method === 'POST' && pathOnly === '/invoke') {
      const body = await readBody(req);
      await handleInvoke(res, req, body);
      return;
    }
    if (method === 'POST' && pathOnly.includes('/messages')) {
      // /tasks/{id}/messages → take the segment between /tasks/ and /messages
      const m = pathOnly.match(/\/tasks\/([^/]+)\/messages/);
      const taskId = m?.[1] ?? '';
      const body = await readBody(req);
      await handleMessages(res, req, taskId, body);
      return;
    }
    if (method === 'POST' && pathOnly.includes('/cancel')) {
      const m = pathOnly.match(/\/tasks\/([^/]+)\/cancel/);
      const taskId = m?.[1] ?? '';
      const body = await readBody(req);
      await handleCancel(res, req, taskId, body);
      return;
    }
    writeSignedTo(res, req, 404, { code: 'not_found' });
  } catch (err) {
    console.error('handler error', err);
    try {
      writeSignedTo(res, req, 500, { code: 'internal_error' });
    } catch {
      // already wrote
    }
  }
  });
}

/**
 * Start the provider server with the given config. Returns a handle
 * to the listening server and a `close()` to stop it.
 *
 * The test harness imports this function and calls it with a config
 * built from randomBytes; the CLI entry point at the bottom of this
 * file calls it with a config built from env vars.
 */
export interface StartedServer {
  port: number;
  close: () => Promise<void>;
}

export function startServer(c: ProviderConfig): StartedServer {
  if (!c.keyId) {
    throw new Error('FATAL: keyId is required');
  }
  config = c;
  store = new Store(c.dbPath ?? './finch-provider.db');
  const server = buildServer();
  server.listen(c.port, '127.0.0.1', () => {
    console.log(`${c.agentName} listening on 127.0.0.1:${c.port}`);
  });
  return {
    port: c.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) {
            reject(err);
            return;
          }
          if (store) {
            store.close();
            store = null;
          }
          resolve();
        });
      }),
  };
}

// ============================================================
// CLI entry point
// ============================================================
// When run as the main module (npx tsx src/provider.ts or deno run ...),
// build a config from env vars and start. When imported (e.g., by the
// test harness), this block is skipped.

declare const require: ((m: string) => { url: string }) | undefined;
declare const module: { filename?: string; url?: string } | undefined;

const isMain =
  (typeof require !== 'undefined' &&
    (require as unknown as { main?: unknown }).main === module) ||
  (typeof import.meta !== 'undefined' &&
    (import.meta as { main?: boolean }).main === true);

if (isMain) {
  try {
    const cfg = readConfig();
    const srv = startServer(cfg);
    const shutdown = (): void => {
      srv.close().then(() => process.exit(0)).catch(() => process.exit(1));
      setTimeout(() => process.exit(1), 3000).unref();
    };
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.on(sig, shutdown);
    }
  } catch (err) {
    console.error((err as Error).message ?? err);
    process.exit(1);
  }
}
