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

### Expose it on a public HTTPS URL (for contract test / live demo)

The mock binds to `127.0.0.1`, so Finch cannot reach it directly. A
zero-install public tunnel can be added with one command in a second
terminal:

```bash
# terminal 1
deno task start

# terminal 2
./scripts/tunnel.sh
# -> prints e.g. https://d384eb40cc3a4e.lhr.life
# -> Ctrl-C to stop
```

`scripts/tunnel.sh` uses `localhost.run` over plain SSH — no extra
software, no account, no signup. The URL is **random per run**; for a
stable URL, register a custom domain at
<https://admin.localhost.run/> and add your SSH public key (see
<https://localhost.run/docs/forever-free/>).

Then point Finch at the public URL:

| Setting | Value |
|---|---|
| `wireProtocol` | `finch_v2` |
| `invocationUrl` | `https://<random>.lhr.life/invoke` |
| `healthUrl`      | `https://<random>.lhr.life/health` |
| `taskUrl`        | (omit for P1 only) |

Verified end-to-end: signed `GET /health` over the tunnel returns
`{"status":"ready",...}` with valid `X-Agent-*` headers (2026-10-13).

## What this is

- **1:1 mirror of the official Python mock** — every protocol behavior corresponds
  to a block in the Python source.
- **P1 sync + P2 async + P3 generation** with deterministic `merchant_task_id`
  and HMAC-SHA256 signed responses.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, strict mode).
- **No runtime dependencies** — uses only Node 22+ / Deno 2.x built-ins
  (`node:crypto`, `node:http`, `node:net`, `node:process`).
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
