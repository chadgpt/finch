/**
 * Inputs: Validated Local or TEST config, optional harness TLS, signed AgentOn requests, and exact HTTPS callback or Artifact origins.
 * Outputs: A deterministic P1-P3 protocol server with bounded I/O and secret-safe diagnostics.
 * Role: Implements Finch's external test merchant wire without importing or composing Web production code.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { isAbsolute } from 'node:path';

const MAX_BODY_BYTES = 1_048_576;
const MAX_CLOCK_SKEW_SECONDS = 300;
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '::1']);
const SCENARIOS = new Set([
  'success', 'input', 'callback', 'replay', 'error', 'timeout', 'invalid_output',
]);
const encoder = new TextEncoder();

function fail(message) {
  throw new Error(message);
}

export function parseConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('CONFIG_INVALID');
  const configKeys = ['listen', 'tls', 'credentials', 'scenario', 'allowedOutboundOrigins'];
  if ('wireProtocol' in value) configKeys.push('wireProtocol');
  if ('timeoutDelayMs' in value) configKeys.push('timeoutDelayMs');
  if ('callbackDelayMs' in value) configKeys.push('callbackDelayMs');
  exactKeys(value, configKeys, 'CONFIG_INVALID');
  const { listen, tls, credentials, scenario } = value;
  exactKeys(listen, ['hostname', 'port'], 'CONFIG_LISTEN_INVALID');
  if (!listen || typeof listen !== 'object' || !LOOPBACK_HOSTNAMES.has(listen.hostname) ||
      !Number.isSafeInteger(listen.port) || listen.port < 0 || listen.port > 65_535) {
    fail('CONFIG_LISTEN_INVALID');
  }
  exactKeys(tls, ['certificatePath', 'privateKeyPath'], 'CONFIG_TLS_INVALID');
  if (!tls || typeof tls !== 'object' || typeof tls.certificatePath !== 'string' ||
      typeof tls.privateKeyPath !== 'string' || !isAbsolute(tls.certificatePath) ||
      !isAbsolute(tls.privateKeyPath)) fail('CONFIG_TLS_INVALID');
  exactKeys(credentials, ['keyId', 'requestSecret', 'callbackSecret'], 'CONFIG_CREDENTIALS_INVALID');
  if (!credentials || typeof credentials !== 'object' ||
      ![credentials.keyId, credentials.requestSecret, credentials.callbackSecret]
        .every((item) => typeof item === 'string' && item.length > 0)) {
    fail('CONFIG_CREDENTIALS_INVALID');
  }
  if (!SCENARIOS.has(scenario)) fail('CONFIG_SCENARIO_INVALID');
  if (value.wireProtocol !== undefined &&
      !['finch_v2', 'agenton_v0'].includes(value.wireProtocol)) fail('CONFIG_WIRE_PROTOCOL_INVALID');
  if (value.timeoutDelayMs !== undefined &&
      (!Number.isSafeInteger(value.timeoutDelayMs) || value.timeoutDelayMs <= 0 || value.timeoutDelayMs > 2_000)) {
    fail('CONFIG_TIMEOUT_INVALID');
  }
  if (value.callbackDelayMs !== undefined &&
      (!Number.isSafeInteger(value.callbackDelayMs) || value.callbackDelayMs < 0 || value.callbackDelayMs > 2_000)) {
    fail('CONFIG_CALLBACK_DELAY_INVALID');
  }
  if (!Array.isArray(value.allowedOutboundOrigins) || value.allowedOutboundOrigins.some((origin) => {
    if (typeof origin !== 'string') return true;
    try {
      const parsed = new URL(origin);
      return parsed.origin !== origin || parsed.protocol !== 'https:' ||
        !LOOPBACK_HOSTNAMES.has(parsed.hostname) || parsed.username || parsed.password || parsed.hash;
    } catch {
      return true;
    }
  })) fail('CONFIG_OUTBOUND_ORIGINS_INVALID');
  return Object.freeze({
    listen: Object.freeze({ hostname: listen.hostname, port: listen.port }),
    tls: Object.freeze({
      certificatePath: tls.certificatePath,
      privateKeyPath: tls.privateKeyPath,
    }),
    credentials: Object.freeze({
      keyId: credentials.keyId,
      requestSecret: credentials.requestSecret,
      callbackSecret: credentials.callbackSecret,
    }),
    wireProtocol: value.wireProtocol ?? 'finch_v2',
    scenario,
    allowedOutboundOrigins: Object.freeze([...new Set(value.allowedOutboundOrigins)]),
    timeoutDelayMs: value.timeoutDelayMs ?? 250,
    callbackDelayMs: value.callbackDelayMs ?? 10,
  });
}

function outboundUrl(rawUrl, config) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('OUTBOUND_URL_INVALID');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      !config.allowedOutboundOrigins.includes(url.origin)) {
    fail('OUTBOUND_DESTINATION_FORBIDDEN');
  }
  return url;
}

async function localFetch(rawUrl, init, config) {
  const url = outboundUrl(rawUrl, config);
  const response = await fetch(url, {
    ...init,
    redirect: 'manual',
    signal: AbortSignal.timeout(2_000),
  });
  if (response.status >= 300 && response.status < 400) fail('OUTBOUND_REDIRECT_FORBIDDEN');
  return response;
}

async function boundedResponseBytes(response, maxBytes) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) fail('OUTBOUND_RESPONSE_TOO_LARGE');
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      fail('OUTBOUND_RESPONSE_TOO_LARGE');
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function bodySha256(body) {
  return createHash('sha256').update(body).digest('hex');
}

function signature({ secret, method, pathWithQuery, timestamp, nonce, body }) {
  const canonical = [method.toUpperCase(), pathWithQuery, timestamp, nonce, bodySha256(body)].join('\n');
  return `v1=${createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')}`;
}

function authNonce() {
  return randomBytes(32).toString('hex');
}

function equalAscii(left, right) {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  return leftBytes.byteLength === rightBytes.byteLength && timingSafeEqual(leftBytes, rightBytes);
}

function headerValues(request, expectedName) {
  const values = [];
  for (let index = 0; index + 1 < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === expectedName.toLowerCase()) {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  return values;
}

function oneHeader(request, name) {
  const values = headerValues(request, name);
  if (values.length !== 1 || !values[0]) fail('AUTH_HEADERS_INVALID');
  return values[0];
}

async function readBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > MAX_BODY_BYTES) fail('REQUEST_TOO_LARGE');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function requestTarget(request) {
  if (typeof request.url !== 'string' || !request.url.startsWith('/')) fail('REQUEST_TARGET_INVALID');
  return request.url;
}

function routedTarget(request, config) {
  const target = new URL(requestTarget(request), 'http://merchant.local');
  const prefix = config.externalPathPrefix ?? '';
  if (prefix === '') return target;
  if (!/^\/[A-Za-z0-9/_-]+$/u.test(prefix) || prefix.endsWith('/') ||
      !target.pathname.startsWith(`${prefix}/`)) {
    fail('REQUEST_TARGET_INVALID');
  }
  target.pathname = target.pathname.slice(prefix.length);
  return target;
}

function verifyRequest({ request, body, config, nonces }) {
  const method = request.method;
  if (method !== 'GET' && method !== 'POST') fail('METHOD_INVALID');
  if (method === 'GET' && body.byteLength !== 0) fail('GET_BODY_INVALID');
  const keyId = oneHeader(request, 'X-Platform-Key-Id');
  const timestamp = oneHeader(request, 'X-Platform-Timestamp');
  const nonce = oneHeader(request, 'X-Platform-Nonce');
  const presented = oneHeader(request, 'X-Platform-Signature');
  if (keyId !== config.credentials.keyId) fail('KEY_ID_INVALID');
  if (!/^v1=[0-9a-f]{64}$/.test(presented)) fail('SIGNATURE_INVALID');
  if (!/^[+-]?[0-9]+$/.test(timestamp.trim())) fail('TIMESTAMP_INVALID');
  const signedAt = Number(timestamp);
  const now = Math.floor(Date.now() / 1_000);
  if (!Number.isSafeInteger(signedAt) || Math.abs(now - signedAt) > MAX_CLOCK_SKEW_SECONDS) {
    fail('TIMESTAMP_INVALID');
  }
  const expected = signature({
    secret: config.credentials.requestSecret,
    method,
    pathWithQuery: requestTarget(request),
    timestamp,
    nonce,
    body,
  });
  if (!equalAscii(expected, presented)) fail('SIGNATURE_INVALID');
  for (const [usedNonce, expiresAt] of nonces) {
    if (expiresAt <= now) nonces.delete(usedNonce);
  }
  const nonceIdentity = `${keyId}\n${nonce}`;
  if (nonces.has(nonceIdentity)) fail('NONCE_REPLAYED');
  nonces.set(nonceIdentity, signedAt + MAX_CLOCK_SKEW_SECONDS + 1);
}

function writeSignedBytes(response, status, body, contentType, request, config, responseNonce) {
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const pathWithQuery = requestTarget(request);
  response.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': String(body.byteLength),
    'X-Agent-Key-Id': config.credentials.keyId,
    'X-Agent-Timestamp': timestamp,
    'X-Agent-Nonce': responseNonce,
    'X-Agent-Signature': signature({
      secret: config.credentials.requestSecret,
      method: request.method,
      pathWithQuery,
      timestamp,
      nonce: responseNonce,
      body,
    }),
  });
  response.end(body);
}

function writeJson(response, status, value, request, config, responseNonce) {
  writeSignedBytes(
    response,
    status,
    encoder.encode(JSON.stringify(value)),
    'application/json',
    request,
    config,
    responseNonce,
  );
}

function p1Value(invocation, scenario) {
  if (scenario === 'input') {
    return {
      protocol_version: '2.0',
      invocation_id: invocation.invocation_id,
      status: 'input_required',
      questions: [{ id: 'local-detail', question: 'Provide the Local test detail.' }],
    };
  }
  const priorVisibleText = invocation.conversation.messages.at(-2)
    ?.content.find((part) => part.type === 'text')?.text;
  return {
    protocol_version: '2.0',
    invocation_id: invocation.invocation_id,
    status: 'completed',
    message: {
      role: 'agent',
      content: [{
        type: 'text',
        text: priorVisibleText === undefined
          ? 'AgentOn Local success.'
          : `AgentOn Local success after ${priorVisibleText}.`,
      }],
    },
    artifacts: [],
  };
}

function parseJson(body) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BODY_INVALID');
    return value;
  } catch {
    fail('BODY_INVALID');
  }
}

function objectValue(value, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(code);
  return value;
}

function exactKeys(value, keys, code) {
  const object = objectValue(value, code);
  const actual = Object.keys(object).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(code);
  return object;
}

function canonicalUuid(value) {
  return typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}

function agentOnInvocationId(value) {
  return typeof value === 'string' && /^ivk_[0-9a-f]{32}$/.test(value);
}

function canonicalHash(value) {
  return typeof value === 'string' && /^0x[0-9a-f]{64}$/.test(value);
}

function canonicalHttpsUrl(value) {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
  } catch {
    return false;
  }
}

function contentParts(value, code) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) fail(code);
  for (const part of value) {
    const object = objectValue(part, code);
    if (object.type === 'text') {
      exactKeys(object, ['type', 'text'], code);
      if (typeof object.text !== 'string') fail(code);
    } else if (object.type === 'json') {
      exactKeys(object, ['type', 'json'], code);
    } else if (['image', 'video', 'file'].includes(object.type)) {
      exactKeys(object, ['type', 'asset_id', 'download_url', 'media_type', 'metadata'], code);
      const metadata = exactKeys(object.metadata, ['bytes', 'sha256'], code);
      if (!canonicalUuid(object.asset_id) || !canonicalHttpsUrl(object.download_url) ||
          typeof object.media_type !== 'string' || !Number.isSafeInteger(metadata.bytes) ||
          metadata.bytes < 0 || typeof metadata.sha256 !== 'string' ||
          !/^[0-9a-f]{64}$/.test(metadata.sha256)) fail(code);
    } else {
      fail(code);
    }
  }
  return value;
}

function outputContract(value, code) {
  const root = exactKeys(value, ['artifacts'], code);
  const artifacts = exactKeys(root.artifacts, [
    'min_items', 'max_items', 'allowed_media_types', 'max_bytes_per_asset', 'max_total_bytes',
  ], code);
  if (![artifacts.min_items, artifacts.max_items, artifacts.max_bytes_per_asset, artifacts.max_total_bytes]
    .every((item) => Number.isSafeInteger(item) && item >= 0) ||
      artifacts.min_items > artifacts.max_items || artifacts.max_items > 100 ||
      !Array.isArray(artifacts.allowed_media_types) || artifacts.allowed_media_types.length === 0 ||
      artifacts.allowed_media_types.some((item) => typeof item !== 'string' || item.length === 0)) {
    fail(code);
  }
  return artifacts;
}

function artifactUploads(value, code) {
  if (!Array.isArray(value) || value.length > 100) fail(code);
  for (const upload of value) {
    const object = exactKeys(upload, [
      'slot_id', 'asset_id', 'put_url', 'allowed_media_types', 'max_bytes', 'expected_kind', 'expires_at',
    ], code);
    if (!canonicalUuid(object.slot_id) || !canonicalUuid(object.asset_id) ||
        !canonicalHttpsUrl(object.put_url) || !Array.isArray(object.allowed_media_types) ||
        object.allowed_media_types.length === 0 ||
        object.allowed_media_types.some((item) => typeof item !== 'string' || item.length === 0) ||
        !Number.isSafeInteger(object.max_bytes) || object.max_bytes <= 0 ||
        !['image', 'video', 'file'].includes(object.expected_kind) ||
        typeof object.expires_at !== 'string' || Number.isNaN(Date.parse(object.expires_at))) fail(code);
  }
  return value;
}

function validateFinchInvocationEnvelope(value) {
  const common = [
    'protocol_version', 'invocation_id', 'dispatch_id', 'service_version_id', 'offer_id',
    'offer_revision', 'interaction_mode', 'quantity', 'terms_hash', 'request_hash', 'limits', 'callback',
  ];
  const mode = value.interaction_mode;
  const modeKeys = mode === 'conversation_turn'
    ? ['conversation', 'input', 'task_completed', 'output_contract', 'artifact_uploads']
    : ['input', 'output_contract', 'artifact_uploads'];
  exactKeys(value, [...common, ...modeKeys], 'INVOCATION_INVALID');
  if (value.protocol_version !== '2.0' || !canonicalUuid(value.invocation_id) ||
      !canonicalUuid(value.dispatch_id) || !canonicalUuid(value.service_version_id) ||
      !canonicalUuid(value.offer_id) || !Number.isSafeInteger(value.offer_revision) ||
      value.offer_revision <= 0 || !['conversation_turn', 'task', 'generation'].includes(mode) ||
      typeof value.quantity !== 'string' || !/^[1-9][0-9]*$/.test(value.quantity) ||
      !canonicalHash(value.terms_hash) || !canonicalHash(value.request_hash)) fail('INVOCATION_INVALID');
  const limits = exactKeys(value.limits, ['deadline_at'], 'INVOCATION_INVALID');
  if (typeof limits.deadline_at !== 'string' || Number.isNaN(Date.parse(limits.deadline_at))) {
    fail('INVOCATION_INVALID');
  }
  const callback = exactKeys(value.callback, ['url', 'callback_key_id'], 'INVOCATION_INVALID');
  if (typeof callback.url !== 'string' || typeof callback.callback_key_id !== 'string' ||
      callback.callback_key_id.length === 0) fail('INVOCATION_INVALID');
  if (!canonicalHttpsUrl(callback.url)) fail('INVOCATION_INVALID');
  const input = exactKeys(value.input, ['content', 'parameters'], 'INVOCATION_INVALID');
  contentParts(input.content, 'INVOCATION_INVALID');
  objectValue(input.parameters, 'INVOCATION_INVALID');
  const contract = outputContract(value.output_contract, 'INVOCATION_INVALID');
  const uploads = artifactUploads(value.artifact_uploads, 'INVOCATION_INVALID');
  if (mode === 'generation') {
    const quantity = Number(value.quantity);
    if (!Number.isSafeInteger(quantity) || contract.min_items !== quantity ||
        contract.max_items !== quantity || uploads.length !== quantity) fail('INVOCATION_INVALID');
  }
  if (mode === 'conversation_turn') {
    if (typeof value.task_completed !== 'boolean') fail('INVOCATION_INVALID');
    const conversation = exactKeys(value.conversation, [
      'conversation_id', 'turn_id', 'context_mode', 'messages',
    ], 'INVOCATION_INVALID');
    if (!canonicalUuid(conversation.conversation_id) || !canonicalUuid(conversation.turn_id) ||
        conversation.context_mode !== 'platform_managed' || !Array.isArray(conversation.messages) ||
        conversation.messages.length === 0 || conversation.messages.length > 20) fail('INVOCATION_INVALID');
    for (const message of conversation.messages) {
      const projected = exactKeys(message, ['message_id', 'role', 'content'], 'INVOCATION_INVALID');
      if (!canonicalUuid(projected.message_id) || !['user', 'agent'].includes(projected.role)) {
        fail('INVOCATION_INVALID');
      }
      contentParts(projected.content, 'INVOCATION_INVALID');
    }
    const last = conversation.messages.at(-1);
    if (last.role !== 'user' || JSON.stringify(last.content) !== JSON.stringify(input.content)) {
      fail('INVOCATION_INVALID');
    }
  }
  return value;
}

function validateAgentOnInvocationEnvelope(value) {
  const agent = objectValue(value.agent, 'INVOCATION_INVALID');
  const mode = agent.interaction_mode;
  const common = [
    'protocol_version', 'invocation_id', 'order', 'agent', 'commercial', 'subject',
    'callback', 'limits',
  ];
  if (value.contract_test !== undefined) common.push('contract_test');
  const modeKeys = mode === 'conversation_turn'
    ? ['conversation', 'input', 'task_completed', 'output_contract', 'artifact_uploads']
    : ['input', 'output_contract', 'artifact_uploads'];
  exactKeys(value, [...common, ...modeKeys], 'INVOCATION_INVALID');
  if (value.protocol_version !== '2.0' || !agentOnInvocationId(value.invocation_id) ||
      !['conversation_turn', 'task', 'generation'].includes(mode) ||
      (value.contract_test !== undefined && value.contract_test !== true)) fail('INVOCATION_INVALID');
  exactKeys(value.order, ['order_id', 'billable_entity_type', 'billable_entity_id'], 'INVOCATION_INVALID');
  exactKeys(agent, ['agent_id', 'version', 'offer_id', 'interaction_mode'], 'INVOCATION_INVALID');
  const commercial = exactKeys(value.commercial, [
    'pricing_version', 'model', 'currency', 'unit', 'unit_price_micro_usdc', 'quantity',
    'authorized_amount_micro_usdc',
  ], 'INVOCATION_INVALID');
  if (!Number.isSafeInteger(commercial.quantity) || commercial.quantity < 1 ||
      commercial.currency !== 'USDC') fail('INVOCATION_INVALID');
  const subject = exactKeys(value.subject, ['user_id', 'locale'], 'INVOCATION_INVALID');
  if (!/^usr_[0-9a-f]{16}$/.test(subject.user_id) || subject.locale !== 'zh-CN') fail('INVOCATION_INVALID');
  const limits = exactKeys(value.limits, ['deadline_at'], 'INVOCATION_INVALID');
  if (typeof limits.deadline_at !== 'string' || Number.isNaN(Date.parse(limits.deadline_at))) {
    fail('INVOCATION_INVALID');
  }
  const callback = exactKeys(value.callback, ['url', 'callback_key_id'], 'INVOCATION_INVALID');
  if (!canonicalHttpsUrl(callback.url) || typeof callback.callback_key_id !== 'string' ||
      callback.callback_key_id.length === 0) fail('INVOCATION_INVALID');
  const input = exactKeys(value.input, ['content', 'parameters'], 'INVOCATION_INVALID');
  contentParts(input.content, 'INVOCATION_INVALID');
  objectValue(input.parameters, 'INVOCATION_INVALID');
  const contract = outputContract(value.output_contract, 'INVOCATION_INVALID');
  const uploads = artifactUploads(value.artifact_uploads, 'INVOCATION_INVALID');
  if (mode === 'generation' &&
      (contract.min_items !== commercial.quantity || uploads.length !== commercial.quantity)) {
    fail('INVOCATION_INVALID');
  }
  if (mode === 'conversation_turn') {
    if (typeof value.task_completed !== 'boolean') fail('INVOCATION_INVALID');
    const conversation = objectValue(value.conversation, 'INVOCATION_INVALID');
    if (conversation.context_mode !== 'platform_managed' || !Array.isArray(conversation.messages) ||
        conversation.messages.length === 0) fail('INVOCATION_INVALID');
    for (const message of conversation.messages) {
      if (!message || typeof message !== 'object' || !['user', 'agent'].includes(message.role)) {
        fail('INVOCATION_INVALID');
      }
      contentParts(message.content, 'INVOCATION_INVALID');
    }
  }
  return { ...value, interaction_mode: mode, quantity: String(commercial.quantity) };
}

function validateInvocationEnvelope(value, wireProtocol) {
  return wireProtocol === 'agenton_v0'
    ? validateAgentOnInvocationEnvelope(value)
    : validateFinchInvocationEnvelope(value);
}

function validateInputEnvelope(value) {
  exactKeys(value, ['protocol_version', 'task_id', 'message'], 'INPUT_INVALID');
  const message = exactKeys(value.message, ['role', 'content'], 'INPUT_INVALID');
  if (value.protocol_version !== '2.0' || !canonicalUuid(value.task_id) || message.role !== 'user') {
    fail('INPUT_INVALID');
  }
  contentParts(message.content, 'INPUT_INVALID');
}

function validateCancelEnvelope(value) {
  exactKeys(value, ['protocol_version', 'reason'], 'CANCEL_INVALID');
  if (value.protocol_version !== '2.0' || value.reason !== 'user_requested') fail('CANCEL_INVALID');
}

function idempotencyRecord(request, body, responses) {
  const key = oneHeader(request, 'Idempotency-Key');
  const digest = bodySha256(body);
  const identity = `${request.method} ${requestTarget(request)}\n${key}`;
  const existing = responses.get(identity);
  if (existing && existing.digest !== digest) return { conflict: true };
  return existing ?? { identity, digest };
}

function providerTaskId(invocationId, idempotencyIdentity) {
  return `agenton-local-${createHash('sha256')
    .update(`${invocationId}\n${idempotencyIdentity}`, 'utf8')
    .digest('hex')
    .slice(0, 24)}`;
}

function taskSnapshot(task) {
  const common = {
    protocol_version: '2.0',
    merchant_task_id: task.providerTaskId,
    sequence: task.sequence,
  };
  if (task.state === 'input_required') {
    return {
      ...common,
      status: 'input_required',
      questions: [{ id: 'local-detail', question: 'Provide the Local test detail.' }],
    };
  }
  if (task.state === 'working') {
    return {
      ...common,
      status: 'working',
      progress: { percent: 50, stage: 'working' },
    };
  }
  if (task.state === 'canceled') return { ...common, status: 'canceled' };
  return {
    ...common,
    status: 'completed',
    ...(task.mode === 'task'
      ? { message: { role: 'agent', content: [{ type: 'text', text: 'AgentOn Local task complete.' }] } }
      : {}),
    artifacts: task.artifacts,
  };
}

async function uploadArtifacts(invocation, config) {
  if (!Array.isArray(invocation.artifact_uploads)) fail('ARTIFACT_UPLOADS_INVALID');
  const reports = [];
  for (let index = 0; index < invocation.artifact_uploads.length; index += 1) {
    const upload = invocation.artifact_uploads[index];
    if (!upload || typeof upload !== 'object' ||
        typeof upload.slot_id !== 'string' || typeof upload.asset_id !== 'string' ||
        typeof upload.put_url !== 'string' || !Array.isArray(upload.allowed_media_types) ||
        typeof upload.allowed_media_types[0] !== 'string' ||
        !Number.isSafeInteger(upload.max_bytes) || upload.max_bytes <= 0) {
      fail('ARTIFACT_UPLOAD_INVALID');
    }
    const bytes = encoder.encode(`AgentOn Local artifact ${index + 1}.\n`);
    if (bytes.byteLength > upload.max_bytes) fail('ARTIFACT_UPLOAD_TOO_LARGE');
    const response = await localFetch(upload.put_url, {
      method: 'PUT',
      headers: config.wireProtocol === 'agenton_v0'
        ? { 'Content-Type': upload.allowed_media_types[0] }
        : {
            'Content-Type': upload.allowed_media_types[0],
            'X-Finch-Artifact-Filename': `agenton-local-${index + 1}.txt`,
          },
      body: bytes,
    }, config);
    const responseBytes = await boundedResponseBytes(response, 65_536);
    if (!response.ok) fail('ARTIFACT_UPLOAD_REJECTED');
    if (config.wireProtocol === 'agenton_v0') {
      const receipt = parseJson(responseBytes);
      if (response.status !== 200 || receipt.status !== 'ready' || receipt.asset_id !== upload.asset_id ||
          receipt.sha256 !== bodySha256(bytes) || receipt.bytes !== bytes.byteLength) {
        fail('ARTIFACT_UPLOAD_RECEIPT_INVALID');
      }
    } else if (response.status !== 204 || responseBytes.byteLength !== 0) {
      fail('ARTIFACT_UPLOAD_RECEIPT_INVALID');
    }
    reports.push({
      slot_id: upload.slot_id,
      asset_id: upload.asset_id,
      sha256: bodySha256(bytes),
      bytes: bytes.byteLength,
      filename: `agenton-local-${index + 1}.txt`,
    });
  }
  return reports;
}

async function readInputArtifacts(invocation, config) {
  for (const part of invocation.input.content) {
    if (!['image', 'video', 'file'].includes(part.type)) continue;
    if (part.metadata.bytes > MAX_BODY_BYTES) fail('INPUT_ARTIFACT_TOO_LARGE');
    const response = await localFetch(part.download_url, {
      method: 'GET',
      headers: { Accept: part.media_type },
    }, config);
    if (!response.ok) fail('INPUT_ARTIFACT_REJECTED');
    const bytes = await boundedResponseBytes(response, part.metadata.bytes);
    if (bytes.byteLength !== part.metadata.bytes || bodySha256(bytes) !== part.metadata.sha256) {
      fail('INPUT_ARTIFACT_INTEGRITY_INVALID');
    }
  }
}

function callbackValue(task) {
  return {
    protocol_version: '2.0',
    event_id: `agenton-local-completed-${task.providerTaskId}`,
    event_type: 'task.completed',
    invocation_id: task.invocationId,
    merchant_task_id: task.providerTaskId,
    sequence: task.sequence,
    ...(task.mode === 'task'
      ? { message: { role: 'agent', content: [{ type: 'text', text: 'AgentOn Local task complete.' }] } }
      : {}),
    artifacts: task.artifacts,
  };
}

async function sendCallback(task, callback, config) {
  if (!callback || typeof callback !== 'object' || typeof callback.url !== 'string' ||
      callback.callback_key_id !== config.credentials.keyId) {
    fail('CALLBACK_INVALID');
  }
  const url = outboundUrl(callback.url, config);
  const pathWithQuery = `${url.pathname}${url.search}`;
  const body = encoder.encode(JSON.stringify(callbackValue(task)));
  const timestamp = String(Math.floor(Date.now() / 1_000));
  const nonce = authNonce();
  const response = await localFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Agent-Key-Id': config.credentials.keyId,
      'X-Agent-Timestamp': timestamp,
      'X-Agent-Nonce': nonce,
      'X-Agent-Signature': signature({
        secret: config.credentials.callbackSecret,
        method: 'POST',
        pathWithQuery,
        timestamp,
        nonce,
        body,
      }),
    },
    body,
  }, config);
  await boundedResponseBytes(response, 65_536);
  if (!response.ok) fail('CALLBACK_REJECTED');
}

export function createMerchantServer(config, tls) {
  const requestNonces = new Map();
  const responses = new Map();
  const tasks = new Map();
  const nextNonce = authNonce;

  const requestListener = async (request, response) => {
    if (request.method === 'GET' && request.url === '/healthz') {
      const body = encoder.encode('{"status":"ready"}');
      response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': String(body.byteLength) });
      response.end(body);
      return;
    }
    let body;
    let authenticated = false;
    try {
      body = await readBody(request);
      verifyRequest({ request, body, config, nonces: requestNonces });
      authenticated = true;
      // Authentication always binds the externally visible path. Only after it succeeds may the
      // TEST fixture remove its explicit reverse-proxy mount prefix for local route matching.
      const target = routedTarget(request, config);
      if (request.method === 'GET' && target.pathname === '/v1/health' && target.search === '') {
        writeSignedBytes(
          response,
          200,
          new Uint8Array(),
          'application/octet-stream',
          request,
          config,
          nextNonce(),
        );
        return;
      }
      const taskMatch = target.pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      const messageMatch = target.pathname.match(/^\/v1\/tasks\/([^/]+)\/messages$/);
      const cancelMatch = target.pathname.match(/^\/v1\/tasks\/([^/]+)\/cancel$/);
      if (request.method === 'GET' && taskMatch) {
        oneHeader(request, 'Idempotency-Key');
        const task = tasks.get(decodeURIComponent(taskMatch[1]));
        if (!task) fail('TASK_NOT_FOUND');
        if (task.state === 'working' && task.polls >= 1) task.state = 'completed';
        const value = taskSnapshot(task);
        if (task.state === 'working') task.polls += 1;
        writeJson(response, 200, value, request, config, nextNonce());
        return;
      }
      if (request.method === 'POST' && messageMatch) {
        const task = tasks.get(decodeURIComponent(messageMatch[1]));
        if (!task) fail('TASK_NOT_FOUND');
        const replay = idempotencyRecord(request, body, responses);
        if (replay.conflict) {
          writeJson(response, 409, { code: 'idempotency_conflict' }, request, config, nextNonce());
          return;
        }
        if (replay.value) {
          writeJson(response, replay.status, replay.value, request, config, nextNonce());
          return;
        }
        const input = parseJson(body);
        validateInputEnvelope(input);
        if (task.state === 'completed' || task.state === 'canceled') {
          writeJson(response, 409, { code: 'task_terminal' }, request, config, nextNonce());
          return;
        }
        if (task.state !== 'input_required') {
          writeJson(response, 409, { code: 'task_not_awaiting_input' }, request, config, nextNonce());
          return;
        }
        task.state = 'completed';
        task.sequence += 1;
        const value = { status: 'accepted', merchant_task_id: task.providerTaskId };
        responses.set(replay.identity, { digest: replay.digest, status: 202, value });
        writeJson(response, 202, value, request, config, nextNonce());
        return;
      }
      if (request.method === 'POST' && cancelMatch) {
        const task = tasks.get(decodeURIComponent(cancelMatch[1]));
        if (!task) fail('TASK_NOT_FOUND');
        const replay = idempotencyRecord(request, body, responses);
        if (replay.conflict) {
          writeJson(response, 409, { code: 'idempotency_conflict' }, request, config, nextNonce());
          return;
        }
        if (replay.value) {
          writeJson(response, replay.status, replay.value, request, config, nextNonce());
          return;
        }
        validateCancelEnvelope(parseJson(body));
        if (task.state === 'completed' || task.state === 'canceled') {
          writeJson(response, 409, { code: 'task_terminal' }, request, config, nextNonce());
          return;
        }
        task.state = 'canceled';
        task.sequence += 1;
        const value = { status: 'canceled', merchant_task_id: task.providerTaskId, sequence: task.sequence };
        responses.set(replay.identity, { digest: replay.digest, status: 200, value });
        writeJson(response, 200, value, request, config, nextNonce());
        return;
      }
      if (request.method !== 'POST' || target.pathname !== '/v1/invoke') fail('ROUTE_NOT_FOUND');
      const replay = idempotencyRecord(request, body, responses);
      if (replay.conflict) {
        writeJson(response, 409, { code: 'idempotency_conflict' }, request, config, nextNonce());
        return;
      }
      if (replay.value) {
        writeJson(response, replay.status, replay.value, request, config, nextNonce());
        return;
      }
      const invocation = validateInvocationEnvelope(parseJson(body), config.wireProtocol ?? 'finch_v2');
      if (config.scenario === 'timeout') {
        setTimeout(() => {
          if (!response.destroyed) writeJson(response, 504, { code: 'local_timeout' }, request, config, nextNonce());
        }, config.timeoutDelayMs).unref();
        return;
      }
      if (config.scenario === 'error') {
        const value = { code: 'local_provider_error' };
        responses.set(replay.identity, { digest: replay.digest, status: 422, value });
        writeJson(response, 422, value, request, config, nextNonce());
        return;
      }
      if (config.scenario === 'invalid_output') {
        const value = { protocol_version: '2.0', status: 'completed', artifacts: null };
        responses.set(replay.identity, { digest: replay.digest, status: 200, value });
        writeJson(response, 200, value, request, config, nextNonce());
        return;
      }
      if (invocation.interaction_mode === 'conversation_turn') {
        const userMessages = invocation.conversation.messages
          .filter((message) => message.role === 'user').length;
        const value = p1Value(
          invocation,
          config.scenario === 'input' && userMessages === 1 && !invocation.task_completed
            ? 'input'
            : 'success',
        );
        responses.set(replay.identity, { digest: replay.digest, status: 200, value });
        writeJson(response, 200, value, request, config, nextNonce());
        return;
      }
      if (invocation.interaction_mode !== 'task' && invocation.interaction_mode !== 'generation') {
        fail('MODE_UNSUPPORTED');
      }
      if (config.scenario === 'callback') outboundUrl(invocation.callback.url, config);
      if (invocation.interaction_mode === 'generation') {
        await readInputArtifacts(invocation, config);
      }
      const task = {
        providerTaskId: providerTaskId(invocation.invocation_id, replay.identity),
        invocationId: invocation.invocation_id,
        mode: invocation.interaction_mode,
        state: config.scenario === 'input'
          ? 'input_required'
          : config.scenario === 'callback'
            ? 'completed'
            : 'working',
        sequence: 1,
        polls: 0,
        artifacts: invocation.interaction_mode === 'generation'
          ? await uploadArtifacts(invocation, config)
          : [],
      };
      tasks.set(task.providerTaskId, task);
      const value = {
        protocol_version: '2.0',
        invocation_id: invocation.invocation_id,
        status: 'accepted',
        merchant_task_id: task.providerTaskId,
        poll_after_ms: 0,
      };
      responses.set(replay.identity, { digest: replay.digest, status: 202, value });
      writeJson(response, 202, value, request, config, nextNonce());
      if (config.scenario === 'callback') {
        setTimeout(() => {
          const deliver = () => sendCallback(task, invocation.callback, config).catch(() => {
            process.stderr.write('CALLBACK_DELIVERY_FAILED\n');
          });
          void deliver().then(deliver);
        }, config.callbackDelayMs).unref();
      }
    } catch {
      if (!response.headersSent) {
        if (authenticated) {
          writeJson(response, 422, { code: 'request_rejected' }, request, config, nextNonce());
        } else {
          const errorBody = encoder.encode('{"code":"request_rejected"}');
          response.writeHead(401, {
            'Content-Type': 'application/json',
            'Content-Length': String(errorBody.byteLength),
          });
          response.end(errorBody);
        }
      } else if (!response.destroyed) {
        response.destroy();
      }
    }
  };
  return tls === undefined
    ? createHttpServer(requestListener)
    : createHttpsServer(tls, requestListener);
}
