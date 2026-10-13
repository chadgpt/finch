/**
 * `/__diag` endpoint integration test.
 *
 * Drives an in-process server, fires a mix of signed + unsigned + replay
 * requests, and asserts the diagnostic snapshot reflects each one. This
 * is what a developer curls after exposing the provider to the internet
 * to see whether the platform is actually calling.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer, readConfig } from '../src/provider.ts';
import { resetMetrics } from '../src/metrics.ts';

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64url');
}

function signRequest(
  method: string, path: string, body: Buffer,
  secretB64: string, keyId: string,
  opts: { ts?: string; nonce?: string } = {},
): { headers: Record<string, string>; ts: string; nonce: string } {
  const key = b64urlDecode(secretB64);
  const ts = opts.ts ?? String(Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomBytes(8).toString('hex');
  const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${crypto.createHash('sha256').update(body).digest('hex')}`;
  const sig = 'v1=' + crypto.createHmac('sha256', key).update(canonical).digest('hex');
  return {
    ts,
    nonce,
    headers: {
      'content-type': 'application/json',
      'x-platform-key-id': keyId,
      'x-platform-timestamp': ts,
      'x-platform-nonce': nonce,
      'x-platform-signature': sig,
    },
  };
}

interface Diag {
  uptime_sec: number;
  started_at: string;
  total_requests: number;
  verify_success: number;
  verify_failure: Record<string, number>;
  last_p2_poll_at: string | null;
  last_p2_poll_task_id: string | null;
  last_invocation_id: string | null;
  last_platform_ts: number | null;
  recent: Array<Record<string, unknown>>;
  ever_called_from_remote: boolean;
}

async function request(
  port: number, method: string, p: string, body?: Buffer,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method,
        headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          let data: any;
          try { data = JSON.parse(text); } catch { data = { _raw: text }; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const results: Array<{ name: string; pass: boolean; detail: string }> = [];
function record(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main(): Promise<void> {
  const cfg = readConfig();
  resetMetrics();
  const server = startServer(cfg);
  // Give the listen() callback a tick to fire.
  await sleep(50);
  console.log(`diag-test server up on :${server.port}\n`);

  const port = server.port;
  const secret = process.env.MOCK_REQUEST_SECRET!;
  const keyId = process.env.MOCK_KEY_ID!;

  // 1) baseline — fresh diag shows zero traffic
  {
    const r = await request(port, 'GET', '/__diag');
    const d = r.data as Diag;
    const ok = r.status === 200 && d.total_requests === 1 && d.verify_success === 0 && d.ever_called_from_remote === false;
    record('1. fresh diag is clean', ok, `requests=${d.total_requests} verify=${d.verify_success}`);
  }

  // 2) unsigned /invoke — verify_failure.missing_header++
  {
    const body = Buffer.from(JSON.stringify({
      protocol_version: '2.0',
      invocation_id: crypto.randomUUID(),
      interaction_mode: 'conversation_turn',
      input: { content: [{ type: 'text', text: 'hi' }] },
    }));
    const r = await request(port, 'POST', '/invoke', body, { 'content-type': 'application/json' });
    const d = (await request(port, 'GET', '/__diag')).data as Diag;
    const ok = r.status === 401 && d.verify_failure.missing_header === 1;
    record('2. unsigned /invoke → 401 + missing_header++', ok, `status=${r.status} missing=${d.verify_failure.missing_header}`);
  }

  // 3) bad signature — verify_failure.bad_signature++
  {
    const body = Buffer.from(JSON.stringify({
      protocol_version: '2.0',
      invocation_id: crypto.randomUUID(),
      interaction_mode: 'conversation_turn',
      input: { content: [{ type: 'text', text: 'hi' }] },
    }));
    const sig = signRequest('POST', '/invoke', body, secret, keyId);
    // Corrupt the signature
    sig.headers['x-platform-signature'] = 'v1=' + '0'.repeat(64);
    const r = await request(port, 'POST', '/invoke', body, sig.headers);
    const d = (await request(port, 'GET', '/__diag')).data as Diag;
    const ok = r.status === 401 && d.verify_failure.bad_signature === 1;
    record('3. bad signature → 401 + bad_signature++', ok, `status=${r.status} bad_sig=${d.verify_failure.bad_signature}`);
  }

  // 4) valid signed /invoke — verify_success++ + last_invocation_id set + recent has entry
  {
    const invId = crypto.randomUUID();
    const body = Buffer.from(JSON.stringify({
      protocol_version: '2.0',
      invocation_id: invId,
      interaction_mode: 'conversation_turn',
      input: { content: [{ type: 'text', text: 'Reply with the single word: DIAG' }] },
    }));
    const sig = signRequest('POST', '/invoke', body, secret, keyId);
    const r = await request(port, 'POST', '/invoke', body, { ...sig.headers, 'idempotency-key': crypto.randomUUID() });
    const d = (await request(port, 'GET', '/__diag')).data as Diag;
    const ok = r.status === 200
      && d.verify_success === 1
      && d.last_invocation_id === invId
      && d.last_platform_ts !== null
      && d.recent.length > 0
      && d.recent[0]?.invocation_id === invId;
    record('4. signed /invoke → success + invocation_id + ring buffer', ok,
      `success=${d.verify_success} inv=${d.last_invocation_id?.slice(0, 8)} recent[0].inv=${(d.recent[0]?.invocation_id as string | undefined)?.slice(0, 8)}`);
  }

  // 5) /tasks/{id} GET (P2 poll) — last_p2_poll_at set
  {
    const r = await request(port, 'GET', '/tasks/mtk-fake-12345');
    // The handler will respond — we don't care if it returns 404 or a task.
    const d = (await request(port, 'GET', '/__diag')).data as Diag;
    const ok = d.last_p2_poll_at !== null && d.last_p2_poll_task_id === 'mtk-fake-12345';
    record('5. /tasks/{id} → last_p2_poll_at set', ok, `poll_at=${d.last_p2_poll_at} task=${d.last_p2_poll_task_id}`);
  }

  // 6) ever_called_from_remote — still false (all our calls are 127.0.0.1)
  {
    const d = (await request(port, 'GET', '/__diag')).data as Diag;
    const ok = d.ever_called_from_remote === false;
    record('6. ever_called_from_remote stays false on local calls', ok, `flag=${d.ever_called_from_remote}`);
  }

  await server.close();

  const passed = results.filter((r) => r.pass).length;
  console.log(`\ndiag_test: ${passed}/${results.length} passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((e) => { console.error('diag_test fatal:', e); process.exit(1); });
