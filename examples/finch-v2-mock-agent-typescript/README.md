# Finch Provider (TypeScript)

TypeScript reference implementation of a Finch `finch_v2` Provider, mirroring the
official Python mock at `deployed-python-mock/app.py`.

**Runs in both Node 22+ and Deno 2.x** with no code changes.

## TL;DR

### Run with Deno (no install)

```bash
deno task test       # 6/6 PASS, no Finch account, no external network
deno task start      # starts provider on 127.0.0.1:28891
deno task check      # type-check both files
```

That's it. Deno is the only tool you need.

### Run with Node 22+

```bash
npm install          # only devDeps: tsx, typescript, @types/node
npm test             # 6/6 PASS
npm start            # starts provider
npm run typecheck    # tsc --noEmit
```

## Talking to a real LLM

By default the P1 `conversation_turn` branch calls a real OpenAI-compatible
LLM at `https://agw.k0s.io` with model `MiniMax-M3`, and uses the model's
text response as the Agent's reply. P2 / P3 behavior is unchanged (they
still ask for clarification / echo a mock artifact).

The integration uses the official [`openai`](https://www.npmjs.com/package/openai)
SDK (v4) — not a hand-rolled HTTP request. The SDK handles auth, JSON
encoding/decoding, timeouts, and typed errors. To switch to any other
OpenAI-compatible gateway, just change `LLM_BASE_URL` and `LLM_MODEL`.

Verify it works locally:

```bash
# 1. start the provider (env vars are read from .env via --env-file in Deno,
#    or set inline in Node)
deno task start

# 2. in another terminal, send a signed P1 turn
python3 - <<'PY'
import base64, hmac, hashlib, time, uuid, urllib.request, json, os
key = base64.urlsafe_b64decode(os.environ['MOCK_REQUEST_SECRET'])
body = json.dumps({
  "protocol_version": "2.0",
  "invocation_id": str(uuid.uuid4()),
  "interaction_mode": "conversation_turn",
  "input": {"content": [{"type":"text","text":"Reply with exactly the word HELLO and nothing else."}]},
}).encode()
ts, n = str(int(time.time())), uuid.uuid4().hex
canonical = f"POST\n/invoke\n{ts}\n{n}\n{hashlib.sha256(body).hexdigest()}"
sig = "v1=" + hmac.new(key, canonical.encode(), hashlib.sha256).hexdigest()
req = urllib.request.Request(
  "http://127.0.0.1:28891/invoke", data=body, method="POST",
  headers={
    "Content-Type": "application/json",
    "Idempotency-Key": uuid.uuid4().hex,
    "X-Platform-Key-Id": os.environ["MOCK_KEY_ID"],
    "X-Platform-Timestamp": ts, "X-Platform-Nonce": n, "X-Platform-Signature": sig,
  })
with urllib.request.urlopen(req, timeout=30) as r:
    print(r.read().decode())
PY
```

You should see the LLM's reply in the `message.content[0].text` field.
End-to-end verified 2026-10-13: a real call to agw.k0s.io with model
`MiniMax-M3` returned `"HELLO"` (after a 1-2s warm-up).

If the gateway returns an error (e.g. quota), the provider responds with
`status: "failed"` and an `error.code` you can use for retry logic.

### LLM env vars

| Var | Default | Notes |
|---|---|---|
| `LLM_BASE_URL` | `https://agw.k0s.io` | SDK appends `/v1/chat/completions` |
| `LLM_API_KEY` | `-` | Sentinel; the gateway accepts the literal `-` Bearer |
| `LLM_MODEL` | `MiniMax-M3` | Verified working model id on this gateway |
| `LLM_SYSTEM_PROMPT` | `You are a helpful agent. Be concise.` | Prepended to every turn |
| `LLM_MAX_TOKENS` | `1024` | Per-response cap |
| `LLM_TIMEOUT_MS` | `30000` | Aborts the HTTP request |

### Switching to Anthropic-style calls

The agw.k0s.io gateway also accepts Anthropic-style POSTs at
`/v1/messages`. To use the Anthropic SDK instead of the openai SDK,
replace the `import OpenAI from 'openai'` and the `client.chat.completions.create`
call in `src/provider.ts` with the equivalent `Anthropic` SDK call. The
wire-level request shape changes (`system` becomes a top-level field
instead of a message), but the ProviderConfig env vars stay the same.

### Disabling the LLM (echo fallback)

The test harness sets `llm: undefined` in its `ProviderConfig` to keep
the original deterministic echo behavior. To do the same at runtime,
omit `LLM_BASE_URL`:

```bash
LLM_BASE_URL= deno task start   # falls back to "P1 mock 已完成:<text>"
```

### Expose it on a public HTTPS URL (for contract test / live demo)

The mock binds to `127.0.0.1`, so Finch cannot reach it directly.
Two zero-install tunnel options are included:

#### Option A: ufo (recommended, supports persistent subdomains)

[ufo](https://github.com/webteleport/ufo) is an open-source
WebTransport-based tunnel (MIT, by the webteleport team). `ufo pub`
allocates a public HTTPS URL on the configured RELAY server and
forwards to your local port.

```bash
# install ufo (puts binary in ~/.k0s/bin)
curl -sL https://k0s.io/install.sh | bash
export PATH="$HOME/.k0s/bin:$PATH"

# terminal 1
deno task start

# terminal 2
# Default: random subdomain on the public ufo relay.
./scripts/tunnel-ufo.sh
# -> prints e.g. https://abc123.ufo.k0s.io

# Persistent subdomain: set RELAY to your own ufo relay that supports persistence.
RELAY=https://ufoufo.k0s.io/finch-dev?persist=1 ./scripts/tunnel-ufo.sh
# -> prints a stable URL that survives restarts (depends on relay config)
```

#### Option B: localhost.run (SSH-only fallback, random subdomain)

If ufo doesn't fit (e.g., sandboxed environments), use the SSH-only
fallback that requires zero software install:

```bash
# terminal 1
deno task start

# terminal 2
./scripts/tunnel.sh
# -> prints e.g. https://d384eb40cc3a4e.lhr.life
```

URL is **random per run**; for a stable URL, register a custom domain at
<https://admin.localhost.run/> and add your SSH public key (see
<https://localhost.run/docs/forever-free/>).

#### Point Finch at the public URL

| Setting | Value |
|---|---|
| `wireProtocol` | `finch_v2` |
| `invocationUrl` | `https://<public-host>/invoke` |
| `healthUrl`      | `https://<public-host>/health` |
| `taskUrl`        | (omit for P1 only) |

End-to-end verified on 2026-10-13: a signed `GET /health` over a
public tunnel returns `{"status":"ready",...}` with valid `X-Agent-*`
headers.

## What this is

- **1:1 mirror of the official Python mock** — every protocol behavior corresponds
  to a block in the Python source.
- **P1 sync + P2 async + P3 generation** with deterministic `merchant_task_id`
  and HMAC-SHA256 signed responses.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, strict mode).
- **No runtime dependencies beyond `openai` SDK** — uses Node 22+ / Deno 2.x
  built-ins (`node:crypto`, `node:http`, `node:net`, `node:process`) plus
  the official `openai@^4` package (mapped via `npm:` in Deno, installed
  normally in Node).
- **Self-contained test** — no Finch account, no external network.

## What this is NOT

- **Not a production Provider.** State is in-memory, callbacks are not sent, the
  P3 upload is permissive, cancel is a stub, and the schema validator is minimal.
  See "Production checklist" below.
- **Not affiliated with Finch.** This is a community reference.

## Files

| File | Purpose |
|---|---|
| `src/provider.ts` | The HTTP server (P1/P2/P3 routes) + HMAC + state machine |
| `test/self_test.ts` | End-to-end test with ephemeral keys (in-process) |
| `deno.json` | Deno tasks: `start`, `test`, `check` |
| `package.json` | Node devDeps: `tsx`, `typescript`, `@types/node` |
| `tsconfig.json` | Strict mode, target ES2022, ESM |
| `.env.example` | Required env vars (placeholders only) |
| `.gitignore` | Excludes `.env`, `node_modules/` |

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/health` | Signed health probe (empty body) |
| `POST` | `/invoke` | P1 sync / P2 initial dispatch / P3 initial dispatch |
| `GET`  | `/tasks/{merchant_task_id}` | Poll task snapshot |
| `POST` | `/tasks/{merchant_task_id}/messages` | Supplemental user input |
| `POST` | `/tasks/{merchant_task_id}/cancel` | Cancel task |

All inbound requests must carry `X-Platform-Key-Id`, `X-Platform-Timestamp`,
`X-Platform-Nonce`, `X-Platform-Signature`. All outbound responses carry the
matching `X-Agent-*` headers, even on 4xx.

## HMAC canonical string

```
METHOD
PATH?QUERY
TIMESTAMP
NONCE
SHA256(body)
```

`METHOD` is uppercased. `PATH?QUERY` preserves the exact request path and query
string. The signature is `v1=` + hex `HMAC-SHA256(secret, canonical)`.

Secrets are 32 raw bytes, displayed as 43-character Base64URL (no padding) in
the workspace. The runtime decodes them via `Buffer.from(s, 'base64url')`.

## Env vars (CLI usage)

| Var | Required | Notes |
|---|---|---|
| `MOCK_REQUEST_SECRET` | yes | Base64URL encoding of 32 raw Request secret bytes |
| `MOCK_CALLBACK_SECRET` | optional | Falls back to `MOCK_REQUEST_SECRET` if unset |
| `MOCK_KEY_ID` | yes | `finch.agenton.<uuid>` from your workspace |
| `MOCK_PORT` | optional | Default `28891` |
| `MOCK_AGENT_NAME` | optional | Default `finch-async-mock-ts` |
| `DEBUG_SIGN` | optional | Set to `1` to log signature-mismatch diagnostics on the server |

### Loading env in Deno (no dotenv library needed)

```bash
deno run --allow-net --allow-env --env-file=.env src/provider.ts
```

Deno 1.43+ reads `.env` natively. No `dotenv` package required.

### Loading env in Node

```bash
MOCK_REQUEST_SECRET=... MOCK_KEY_ID=... npm start
# or use a wrapper like dotenv / direnv / systemd EnvironmentFile
```

## Using `startServer()` from your own code

```typescript
import { startServer, readConfig } from './src/provider.ts';

// Option A: read env, then start (CLI pattern)
const srv = startServer(readConfig());

// Option B: build config inline (test pattern)
const srv = startServer({
  requestSecret: mySecret,           // 32-byte Buffer
  callbackSecret: myCallbackSecret,  // 32-byte Buffer
  keyId: 'finch.agenton.<uuid>',
  port: 0,                            // 0 = pick a free port
  agentName: 'my-agent',
  debugSign: false,
});
// srv.port is the actual bound port
// srv.close() to stop
```

## Production checklist (from the official Python mock)

Before going live:

- [ ] Replace in-memory `_tasks` and `_seenNonces` with Redis or Postgres.
- [ ] Implement outbound callback delivery (POST to `callback.url` with the Callback secret).
- [ ] Strict P3 upload: never fall back to `text/plain`; respect `allowed_media_types` exactly.
- [ ] Add a real schema validator (Ajv in strict mode) for the full `finch_v2` envelope.
- [ ] Enforce `limits.deadline_at`; reject overdue invocations before doing real work.
- [ ] Run multiple processes behind a load balancer; nonces must be shared across processes.
- [ ] Add structured logging with `invocation_id`, `dispatch_id`, `merchant_task_id`, `credential revision`.
- [ ] Validate the `output_contract.artifacts` against the `artifact_uploads` you actually consume.
- [ ] Bind the verifier to a frozen `service_version_id` + `credential revision`; reject requests bound to other revisions.
- [ ] Add a graceful cancel handler.

## License

Same as the official Python mock — Finch does not specify a license for the
deployed source. Treat as reference-only; do not redistribute as your own.
