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

## What this is

- **1:1 mirror of the official Python mock** — every protocol behavior corresponds
  to a block in the Python source.
- **P1 sync + P2 async + P3 generation** with deterministic `merchant_task_id`
  and HMAC-SHA256 signed responses.
- **Strict TypeScript** (`noUncheckedIndexedAccess`, strict mode).
- **No runtime dependencies** beyond `openai` SDK — uses Node 22+ / Deno 2.x
  built-ins (`node:crypto`, `node:http`, `node:net`, `node:process`,
  `node:sqlite`) plus the official `openai@^4` package (mapped via `npm:` in
  Deno, installed normally in Node).
- **State persistence** via built-in `node:sqlite` — no Redis, no native
  modules, no external DB. Same DB file works across server restarts;
  re-sending the same `Idempotency-Key` returns the same `merchant_task_id`.
- **Self-contained test** — no Finch account, no external network.

## What this is NOT

- **Not a production Provider.** Callbacks are not sent, the P3 upload is
  permissive, cancel is a stub, and the schema validator is minimal.
  See "Production checklist" below.
- **Not affiliated with Finch.** This is a community reference.

## Files

| File | Purpose |
|---|---|
| `src/provider.ts` | The HTTP server (P1/P2/P3 routes) + HMAC + state machine |
| `src/db.ts` | SQLite-backed store (tasks + nonces) using `node:sqlite` |
| `test/self_test.ts` | End-to-end test with ephemeral keys (in-process) |
| `test/e2e_llm.py` | One-shot LLM probe script (sends a signed P1 turn) |
| `deno.json` | Deno tasks: `start`, `test`, `check` |
| `package.json` | Node devDeps + `openai` runtime dep |
| `tsconfig.json` | Strict mode, target ES2022, ESM |
| `.env.example` | Required env vars (placeholders only) |
| `.gitignore` | Excludes `.env`, `node_modules/`, `*.db*` |

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
| `FINCH_DB_PATH` | optional | SQLite file path. Default `./finch-provider.db` |
| `LLM_*` | optional | See "Talking to a real LLM" section below |

## Talking to a real LLM

The P1 `conversation_turn` branch calls an OpenAI-compatible gateway by
default (`https://agw.k0s.io`, model `MiniMax-M3`). The integration uses
the official [`openai`](https://www.npmjs.com/package/openai) SDK v4 — not
a hand-rolled HTTP request.

Quick verify:

```bash
# 1. Start the server
deno task start          # or: npm start

# 2. In another terminal, send a signed P1 turn
MOCK_KEY_ID=... MOCK_REQUEST_SECRET=... python3 test/e2e_llm.py
```

You should see `text: '...HELLO'` in the response. End-to-end verified
2026-10-13 with a real agw.k0s.io call.

To switch to a different OpenAI-compatible gateway, just change
`LLM_BASE_URL` and `LLM_MODEL`. To switch to Anthropic-style calls, swap
the SDK in `src/provider.ts` (the env vars stay the same). To disable
the LLM and use the deterministic echo fallback, leave `LLM_BASE_URL` empty.
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

## State persistence

Tasks and nonces are stored in a local SQLite file at `FINCH_DB_PATH`
(default `./finch-provider.db`). The schema is auto-migrated on first start:

```sql
CREATE TABLE tasks (
  merchant_task_id TEXT PRIMARY KEY,
  invocation_id    TEXT NOT NULL,
  state            TEXT NOT NULL,        -- working | input_required | completed
  sequence         INTEGER NOT NULL,
  contract_test    INTEGER NOT NULL,
  answer           TEXT,
  ready_at         REAL NOT NULL,
  completed        INTEGER NOT NULL,
  question         TEXT NOT NULL,
  mode             TEXT NOT NULL,
  artifacts_json   TEXT NOT NULL,
  created_at       REAL NOT NULL
);
CREATE TABLE nonces (
  nonce   TEXT PRIMARY KEY,
  seen_at REAL NOT NULL
);
```

Uses the built-in `node:sqlite` module — no external DB driver, no native
compilation, no Redis. Available in both Node 22.5+ and Deno 2.x. End-to-end
verified that a server restart with the same `FINCH_DB_PATH` returns the
same `merchant_task_id` for a replayed `Idempotency-Key` and a `completed`
snapshot for tasks that have already advanced.

For multi-process deployments, switch the store to a real RDBMS or Redis
(see "Production checklist" — the `Store` class in `src/db.ts` is the only
seam to swap).

## Production checklist (from the official Python mock)

Before going live:

- [ ] Replace the local SQLite `Store` with a shared RDBMS or Redis if you run
      multiple processes. Single-process: SQLite is enough.
- [ ] Implement outbound callback delivery (POST to `callback.url` with the Callback secret).
- [ ] Strict P3 upload: never fall back to `text/plain`; respect `allowed_media_types` exactly.
- [ ] Add a real schema validator (Ajv in strict mode) for the full `finch_v2` envelope.
- [ ] Enforce `limits.deadline_at`; reject overdue invocations before doing real work.
- [ ] Add structured logging with `invocation_id`, `dispatch_id`, `merchant_task_id`, `credential revision`.
- [ ] Validate the `output_contract.artifacts` against the `artifact_uploads` you actually consume.
- [ ] Bind the verifier to a frozen `service_version_id` + `credential revision`; reject requests bound to other revisions.
- [ ] Add a graceful cancel handler.

## License

Same as the official Python mock — Finch does not specify a license for the
deployed source. Treat as reference-only; do not redistribute as your own.
