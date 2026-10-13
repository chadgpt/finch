#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
/**
 * Self-contained local test for the TypeScript finch_v2 mock.
 * Generates ephemeral 32-byte secrets, starts the provider in-process
 * via startServer(), signs and dispatches P1/P2/P3 probes, verifies responses.
 *
 * No Finch account, no external network, no leaked credentials.
 * Mirrors `deployed-python-mock/self_test.py`.
 *
 * Cross-runtime: runs in both Node 22+ (via tsx) and Deno 2.x (via deno run).
 */

import { createHmac, createHash, randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as net from 'node:net';
import process from 'node:process';
import { setTimeout as wait } from 'node:timers/promises';
import { startServer, type StartedServer, type ProviderConfig } from '../src/provider.ts';

// --- Helpers ---

function sign(
  key: Buffer,
  method: string,
  path: string,
  timestamp: string,
  nonce: string,
  body: Buffer,
): string {
  const canonical = [method, path, timestamp, nonce, createHash('sha256').update(body).digest('hex')].join('\n');
  return 'v1=' + createHmac('sha256', key).update(canonical).digest('hex');
}

interface SignedRequestOptions {
  method: string;
  path: string;
  body?: Buffer;
  signingKey: Buffer;
  keyId: string;
  origin: string;
  expectedStatus?: number;
  idempotencyKey?: string;
}

interface SignedResponse {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  json: () => unknown;
}

function signedRequest(opts: SignedRequestOptions): Promise<SignedResponse> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? Buffer.alloc(0);
    const ts = String(Math.floor(Date.now() / 1000));
    const nonce = randomUUID().replace(/-/g, '');
    const sig = sign(opts.signingKey, opts.method, opts.path, ts, nonce, body);
    const headers: Record<string, string> = {
      'X-Platform-Key-Id': opts.keyId,
      'X-Platform-Timestamp': ts,
      'X-Platform-Nonce': nonce,
      'X-Platform-Signature': sig,
    };
    if (body.length > 0) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const reqOpts: RequestOptions = { method: opts.method, headers };
    const r = httpRequest(opts.origin + opts.path, reqOpts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode ?? 0,
          body: raw,
          headers: res.headers,
          json: () => JSON.parse(raw),
        });
      });
    });
    r.on('error', reject);
    if (body.length > 0) r.write(body);
    r.end();
  });
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no port'));
      }
    });
  });
}

// --- Test plan ---

async function main(): Promise<void> {
  const requestKey = randomBytes(32);
  const callbackKey = randomBytes(32);
  const keyId = 'ephemeral-self-test-key';

  // Local upload sink for P3
  const uploads: Array<{ body: Buffer; filename?: string }> = [];
  const sink = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      uploads.push({
        body: Buffer.concat(chunks),
        filename: req.headers['x-finch-artifact-filename'] as string | undefined,
      });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => sink.listen(0, '127.0.0.1', resolve));
  const sinkPort = (sink.address() as net.AddressInfo).port;

  const port = await getFreePort();

  // Start the provider in-process with our ephemeral config.
  // No subprocess, no `npx tsx` / `deno run` indirection — works the same
  // way in Node and Deno.
  const cfg: ProviderConfig = {
    requestSecret: requestKey,
    callbackSecret: callbackKey,
    keyId,
    port,
    agentName: 'self-test',
    debugSign: false,
  };
  const server: StartedServer = startServer(cfg);
  // Give the server a tick to start listening.
  await wait(50);

  const origin = `http://127.0.0.1:${port}`;
  const sinkOrigin = `http://127.0.0.1:${sinkPort}`;

  function call(
    method: string,
    path: string,
    payload?: unknown,
    expected = 200,
    signingKey: Buffer = requestKey,
    idempotencyKey?: string,
  ): Promise<SignedResponse> {
    const body = payload ? Buffer.from(JSON.stringify(payload)) : undefined;
    return signedRequest({
      method,
      path,
      body,
      signingKey,
      keyId,
      origin,
      expectedStatus: expected,
      idempotencyKey: idempotencyKey ?? (body ? randomUUID().replace(/-/g, '') : undefined),
    }).then((resp) => {
      if (expected !== undefined && resp.status !== expected) {
        throw new Error(`${method} ${path}: expected ${expected}, got ${resp.status}: ${resp.body}`);
      }
      const sigHeader = resp.headers['x-agent-signature'];
      const tsHeader = resp.headers['x-agent-timestamp'];
      const nonceHeader = resp.headers['x-agent-nonce'];
      if (typeof sigHeader !== 'string' || typeof tsHeader !== 'string' || typeof nonceHeader !== 'string') {
        throw new Error(`${method} ${path}: missing X-Agent-* headers`);
      }
      if (resp.headers['x-agent-key-id'] !== keyId) {
        throw new Error(`${method} ${path}: X-Agent-Key-Id mismatch`);
      }
      const expectedSig = sign(requestKey, method, path, tsHeader, nonceHeader, Buffer.from(resp.body));
      if (!safeEq(expectedSig, sigHeader)) {
        throw new Error(`${method} ${path}: response signature mismatch`);
      }
      return resp;
    });
  }

  function safeEq(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  function invoke(mode: 'task' | 'generation' | 'conversation_turn' = 'task', contractTest = true, slots: unknown[] = []) {
    const invocationId = randomUUID();
    const payload = {
      protocol_version: '2.0',
      invocation_id: invocationId,
      interaction_mode: mode,
      input: { content: [{ type: 'text', text: 'Mock probe' }], parameters: { contract_test: contractTest } },
      conversation: { messages: [{ role: 'user', content: [{ type: 'text', text: 'P1 probe' }] }] },
      artifact_uploads: slots,
    };
    const expected = mode === 'conversation_turn' ? 200 : 202;
    return call('POST', '/invoke', payload, expected).then((resp) => {
      const j = resp.json() as { invocation_id: string; merchant_task_id?: string };
      if (j.invocation_id !== invocationId) {
        throw new Error('invocation_id mismatch');
      }
      return j as { invocation_id: string; merchant_task_id: string };
    });
  }

  async function poll(taskId: string, status: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const resp = await call('GET', `/tasks/${taskId}`, undefined, 200);
      const j = resp.json() as { status: string; merchant_task_id: string };
      if (j.merchant_task_id !== taskId) {
        throw new Error('poll returned wrong merchant_task_id');
      }
      if (j.status === status) return j as unknown as Record<string, unknown>;
      await wait(100);
    }
    throw new Error(`Task ${taskId} never reached ${status}`);
  }

  try {
    // 1) Health (signed)
    const healthOk = await call('GET', '/health', undefined, 200);
    const healthBody = healthOk.json() as { status: string };
    if (healthBody.status !== 'ready') throw new Error('health not ready');
    console.log('PASS signed health response');

    // 2) Health (bad signature)
    const healthBad = await call('GET', '/health', undefined, 401, randomBytes(32));
    const healthBadBody = healthBad.json() as { code: string };
    if (healthBadBody.code !== 'auth_failed') throw new Error('bad-sig health wrong code');
    console.log('PASS invalid-signature rejection');

    // 3) P1 conversation_turn
    const p1 = await invoke('conversation_turn', true, []);
    if ((p1 as unknown as { status: string }).status !== 'completed') throw new Error('P1 not completed');
    console.log('PASS P1 synchronous text completion');

    // 4) P2 contract test: accepted → working → completed
    const accepted = await invoke('task', true, []);
    const taskId = accepted.merchant_task_id;
    const initial = await call('GET', `/tasks/${taskId}`, undefined, 200);
    const initialBody = initial.json() as { status: string };
    if (initialBody.status !== 'working') throw new Error(`P2 initial status ${initialBody.status}`);
    const completed = await poll(taskId, 'completed');
    const cBody = completed as { message: { role: string }; artifacts: unknown[] };
    if (cBody.message?.role !== 'agent') throw new Error('P2 completed message role not agent');
    if ((cBody.artifacts?.length ?? 0) !== 0) throw new Error('P2 should have no artifacts');
    console.log('PASS P2 contract test: accepted -> working -> completed');

    // 5) P2 supplemental input
    const accepted2 = await invoke('task', false, []);
    const taskId2 = accepted2.merchant_task_id;
    const ir = await poll(taskId2, 'input_required');
    if (!Array.isArray(ir.questions)) throw new Error('P2 missing questions');
    const messagesResp = await call(
      'POST',
      `/tasks/${taskId2}/messages`,
      {
        protocol_version: '2.0',
        task_id: randomUUID(),
        message: { role: 'user', content: [{ type: 'text', text: 'self-test-answer' }] },
      },
      202,
    );
    if (messagesResp.status !== 202) throw new Error(`messages POST got ${messagesResp.status}`);
    const final = await poll(taskId2, 'completed');
    const fBody = final as { message: { content: { text: string }[] } };
    const finalText = fBody.message?.content?.[0]?.text ?? '';
    if (!finalText.includes('self-test-answer')) {
      throw new Error(`P2 final message missing answer: ${finalText}`);
    }
    console.log('PASS P2 supplemental input and final answer');

    // 6) P3 local artifact upload
    const slotId = randomUUID();
    const assetId = randomUUID();
    const accepted3 = await invoke('generation', true, [
      {
        slot_id: slotId,
        asset_id: assetId,
        put_url: `${sinkOrigin}/upload`,
        allowed_media_types: ['text/plain'],
        max_bytes: 1024,
      },
    ]);
    const taskId3 = accepted3.merchant_task_id;
    const gen = (await poll(taskId3, 'completed')) as { artifacts: { slot_id: string; asset_id: string; sha256: string; bytes: number }[] };
    const art = gen.artifacts?.[0];
    if (!art) throw new Error('P3 missing artifact');
    if (art.slot_id !== slotId || art.asset_id !== assetId) throw new Error('P3 artifact id mismatch');
    if (uploads.length === 0) throw new Error('P3 sink got no upload');
    const firstUpload = uploads[0];
    if (!firstUpload) throw new Error('P3 sink first upload undefined');
    if (art.sha256 !== createHash('sha256').update(firstUpload.body).digest('hex')) {
      throw new Error('P3 sha256 mismatch');
    }
    if (art.bytes !== firstUpload.body.length) throw new Error('P3 bytes mismatch');
    if (!firstUpload.filename) throw new Error('P3 missing X-Finch-Artifact-Filename');
    console.log('PASS P3 local artifact upload and completed snapshot');

    console.log('All local checks passed; no Finch or merchant endpoints were called.');
  } finally {
    await server.close();
    await new Promise<void>((resolve) => sink.close(() => resolve()));
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error('FAIL', err);
    process.exit(1);
  },
);
