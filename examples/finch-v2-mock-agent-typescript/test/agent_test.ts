/**
 * Multi-turn / tool-use / streaming e2e test for the agent layer.
 *
 * Hits the LLM through provider.ts → agent.ts → pi-ai.
 * Verifies:
 *   1. Single-turn text completion (baseline)
 *   2. Multi-turn context (model sees prior user + assistant turns)
 *   3. Tool use (model calls get_current_time and gets a result)
 *
 * Run: set -a; source .pi-ai.env; source .pi-ai.llm.env; set +a;
 *      npx tsx test/agent_test.ts
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { startServer, readConfig } from '../src/provider.ts';

const PORT = parseInt(process.env.MOCK_PORT ?? '28894', 10);
const HOST = '127.0.0.1';

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s + '='.repeat((4 - (s.length % 4)) % 4), 'base64url');
}

function signRequest(method: string, path: string, body: Buffer, secretB64: string, keyId: string) {
  const key = b64urlDecode(secretB64);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString('hex');
  const canonical = `${method}\n${path}\n${ts}\n${nonce}\n${crypto.createHash('sha256').update(body).digest('hex')}`;
  const sig = 'v1=' + crypto.createHmac('sha256', key).update(canonical).digest('hex');
  return {
    headers: {
      'content-type': 'application/json',
      'x-platform-key-id': keyId,
      'x-platform-timestamp': ts,
      'x-platform-nonce': nonce,
      'x-platform-signature': sig,
    },
  };
}

interface TestResult { name: string; pass: boolean; detail: string; }

async function invoke(body: object, idemKey?: string): Promise<{ status: number; data: any }> {
  const json = Buffer.from(JSON.stringify(body));
  const sig = signRequest('POST', '/invoke', json, process.env.MOCK_REQUEST_SECRET!, process.env.MOCK_KEY_ID!);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: HOST, port: PORT, path: '/invoke', method: 'POST',
      headers: { ...sig.headers, 'content-length': String(json.length), ...(idemKey ? { 'idempotency-key': idemKey } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          resolve({ status: res.statusCode ?? 0, data: JSON.parse(text) });
        } catch {
          resolve({ status: res.statusCode ?? 0, data: { _raw: text } });
        }
      });
    });
    req.on('error', reject);
    req.write(json);
    req.end();
  });
}

const results: TestResult[] = [];
function record(name: string, pass: boolean, detail = ''): void {
  results.push({ name, pass, detail });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
}

async function main(): Promise<void> {
  // Bring up an in-process server (does not conflict with anything else on PORT)
  // NOTE: startServer takes a config; we use the same env the test runs in.
  const cfg = readConfig();
  if (cfg.port !== PORT) {
    console.error(`Config port ${cfg.port} != expected ${PORT}. Aborting.`);
    process.exit(1);
  }
  const server = startServer(cfg);
  console.log(`agent-test server up on :${PORT}\n`);

  try {
    // 1) Baseline single-turn — model replies concisely
    {
      const r = await invoke({
        protocol_version: '2.0',
        invocation_id: crypto.randomUUID(),
        interaction_mode: 'conversation_turn',
        input: { content: [{ type: 'text', text: 'Reply with the single word: ACK' }] },
      });
      const text = String(r.data?.message?.content?.[0]?.text ?? '').trim();
      const ok = r.status === 200 && r.data?.status === 'completed' && /ACK/.test(text);
      record('1. baseline single-turn', ok, `text=${JSON.stringify(text).slice(0, 80)}`);
    }

    // 2) Multi-turn context — prior assistant turn is in conversation.messages
    {
      const r = await invoke({
        protocol_version: '2.0',
        invocation_id: crypto.randomUUID(),
        interaction_mode: 'conversation_turn',
        conversation: {
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'My favorite color is blue.' }] },
            { role: 'agent', content: [{ type: 'text', text: 'Got it — blue noted.' }] },
          ],
        },
        input: { content: [{ type: 'text', text: 'What is my favorite color? Reply with the color only.' }] },
      });
      const text = String(r.data?.message?.content?.[0]?.text ?? '').trim();
      const ok = r.status === 200 && /blue/i.test(text);
      record('2. multi-turn context retained', ok, `text=${JSON.stringify(text).slice(0, 80)}`);
    }

    // 3) Tool use — the model should call get_current_time when asked "what time is it?"
    // The agent runs the tool, then either returns the model's natural text
    // or (if the model keeps calling tools) hits maxToolSteps and synthesises
    // a summary with the last tool result. Both formats are accepted.
    // The upstream gateway is sometimes flaky about tool registration; we
    // retry once on a "tool not found" hallucination.
    {
      let ok = false;
      let lastText = '';
      for (let attempt = 0; attempt < 2 && !ok; attempt++) {
        const r = await invoke({
          protocol_version: '2.0',
          invocation_id: crypto.randomUUID(),
          interaction_mode: 'conversation_turn',
          input: { content: [{ type: 'text', text: 'Use the get_current_time tool to find the current UTC time, then reply with the tool result.' }] },
        });
        lastText = String(r.data?.message?.content?.[0]?.text ?? '').trim();
        // Accept either:
        //   a) ISO 8601 timestamp appears in the natural text reply
        //   b) "[agent loop ended at N step(s); last tool result: <iso>...]"
        //      (model kept calling the tool until maxToolSteps, then agent
        //      synthesised a summary containing the last tool result)
        const isoMatch = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(lastText);
        ok = r.status === 200 && isoMatch;
        if (!ok && attempt === 0) {
          // small backoff before retry
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      record('3. tool use (get_current_time)', ok, `text=${JSON.stringify(lastText).slice(0, 200)}`);
    }

    // 4) Streaming — LlmProvider.stream() yields text deltas. Drive it
    //    directly (not through the protocol) to keep the assertion focused.
    {
      const { createLlmProvider, LlmError } = await import('../src/llm.ts');
      const cfg = (server as unknown as { port: number }).port
        ? readConfig()
        : readConfig();
      if (cfg.llm) {
        const llmCfg = {
          baseUrl: cfg.llm.baseUrl,
          apiKey: cfg.llm.apiKey,
          model: cfg.llm.model,
          systemPrompt: cfg.llm.systemPrompt ?? 'You are a helpful agent.',
          maxTokens: cfg.llm.maxTokens ?? 1024,
          timeoutMs: cfg.llm.timeoutMs ?? 30000,
        };
        const provider = createLlmProvider(llmCfg);
        let chunks = 0;
        let total = '';
        try {
          for await (const chunk of provider.stream({
            model: cfg.llm.model,
            messages: [{ role: 'user', content: 'Reply with exactly: STREAM' }],
            max_tokens: 32,
          })) {
            chunks++;
            total += chunk;
          }
        } catch (e) {
          if (e instanceof LlmError) {
            record('4. streaming text deltas', false, `LlmError: ${e.code} ${e.message}`);
            return;
          }
          throw e;
        }
        const ok = chunks > 0 && /STREAM/.test(total);
        record('4. streaming text deltas', ok, `chunks=${chunks}, total=${JSON.stringify(total).slice(0, 80)}`);
      } else {
        record('4. streaming text deltas', false, 'no LLM configured');
      }
    }
  } finally {
    await server.close();
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(`\nagent_test: ${passed}/${total} passed`);
  if (passed !== total) process.exit(1);
}

main().catch((e) => {
  console.error('agent_test fatal:', e);
  process.exit(1);
});
