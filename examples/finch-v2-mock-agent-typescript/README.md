# Finch Provider (TypeScript)

TypeScript reference implementation of a Finch `finch_v2` Provider. Mirrors the
official Python mock at `../finch-v2-mock-agent/deployed-python-mock/app.py`,
extends it with a **real LLM agent** built on the
[earendil-works/pi](https://www.npmjs.com/org/earendil-works) stack
(`@earendil-works/pi-ai` + `pi-agent-core` + `pi-tui`), and persists
multi-turn history in built-in `node:sqlite`.

**Runs in both Node 22+ and Deno 2.x** with no code changes.

## TL;DR

### Run with Deno (no install)

```bash
deno task test:all   # self_test 6/6 + history_test 8/8 + diag_test 6/6 + agent_test 4/4
deno task start      # starts HTTP provider on 127.0.0.1:28891
deno task cli ask    # interactive REPL against the agent
deno task check      # type-check all source files
```

That's it. Deno is the only tool you need.

> **Deno caveat:** `test/agent_test.ts` hits a real LLM (pi-ai → gateway) and
> needs `--allow-sys` for pi-ai's user-agent helper. The `test:all` task
> already includes it. Also, if you run on a filesystem where libsqlite's
> FFI binding is unhappy (NFS mounts, some FUSE setups), set
> `FINCH_DB_PATH=/tmp/whatever.db` — the Store class writes wherever you
> point it.

```bash
npm install          # only devDeps + @earendil-works/pi-* runtime deps
npm run test:all     # self_test (6) + history_test (8) + agent_test (4)
npm start            # starts HTTP provider
npx tsx src/cli.ts ask   # interactive REPL
npm run typecheck    # tsc --noEmit
```

## What this is

- **1:1 mirror of the official Python mock** — every protocol behavior
  corresponds to a block in the Python source (HMAC, P1 sync, P2 async,
  P3 generation, contract test, signed outbound).
- **pi-native LLM layer** — the P1 conversation_turn path drives a real
  agent (`src/agent.ts`) built on `@earendil-works/pi-ai` for unified
  OpenAI / Anthropic / Google / Bedrock model support. Tool-calling,
  streaming, multi-turn, and (via `pi-tui`) interactive TUI are first-class.
- **Three subcommands** via `npx tsx src/cli.ts`:
  - `start` — HTTP provider
  - `ask` — interactive REPL or `--prompt "..."` one-shot
  - (TUI components are wired but the REPL uses a minimal spinner; swap
    in `@earendil-works/pi-tui` for the full chat experience)
- **Strict TypeScript** (`noUncheckedIndexedAccess`, strict mode).
- **State persistence** via built-in `node:sqlite` — no Redis, no native
  modules, no external DB. Same DB file works across server restarts;
  re-sending the same `Idempotency-Key` returns the same `merchant_task_id`.
- **Three test suites**:
  - `test/self_test.ts` — 6/6 protocol-level checks (no LLM, no network)
  - `src/history.test.ts` — 8/8 store + LLM-history conversion
  - `test/agent_test.ts` — 4/4 end-to-end against a real LLM
    (single-turn, multi-turn, tool use, streaming)

## What this is NOT

- **Not a production Provider.** Callbacks are not sent, the P3 upload is
  permissive, cancel is a stub, and the schema validator is minimal.
  See "Production checklist" below.
- **Not affiliated with Finch.** This is a community reference.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  HTTP server (src/provider.ts)                                 │
│                                                                │
│   POST /invoke    ┌── P1 sync  ──┐                             │
│                   │  → agent.ts  │                             │
│                   └── P2 async ──┤  (P2 state machine in       │
│                   └── P3 gen  ───┘   store / SQLite)            │
│   POST /tasks/{id}              → returns P2 status            │
│   GET  /health                                                   │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  Agent core (src/agent.ts)                                     │
│                                                                │
│   runAgentTurn({ llm, systemPrompt, model, maxTokens,          │
│                  extraTools, onEvent })                         │
│     ├── builds ChatMessage[] history                           │
│     ├── loops up to maxToolSteps (default 5):                  │
│     │     1. llm.complete(req)                                 │
│     │     2. if tool_calls → execute each, append tool result  │
│     │     3. else → return final text                          │
│     └── returns { text, toolCalls, usage, steps }              │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌────────────────────────────────────────────────────────────────┐
│  LLM abstraction (src/llm.ts)                                 │
│                                                                │
│   LlmProvider interface (name, complete, stream)                │
│     └── PiAiProvider wraps @earendil-works/pi-ai                │
│         ├── createProvider({ auth: envApiKeyAuth(...) })       │
│         ├── openAICompletionsApi() OR anthropicMessagesApi()   │
│         └── routes by baseUrl to OpenAI or Anthropic format    │
│                                                                │
│   BUILTIN_TOOLS:                                                │
│     ├── get_current_time (real tool)                            │
│     └── decide_response (signal tool for P2 async)              │
└────────────────────────────────────────────────────────────────┘
                          │
                          ▼
                LLM gateway (e.g. https://agw.k0s.io/v1)
```

## Configuration

All configuration is via environment variables — see `.env.example`:

| Var | Default | Description |
|---|---|---|
| `MOCK_REQUEST_SECRET` | *(required)* | Base64URL of 32 raw HMAC bytes (Finch request side) |
| `MOCK_CALLBACK_SECRET` | *(same as request)* | Base64URL of 32 raw HMAC bytes (Finch callback side) |
| `MOCK_KEY_ID` | `finch.agenton.<uuid>` | Your provider key id from the Finch workspace |
| `MOCK_PORT` | `28891` | HTTP listen port |
| `FINCH_DB_PATH` | `./finch-provider.db` | SQLite file path (auto-migrated) |
| `LLM_BASE_URL` | `https://agw.k0s.io/v1` | OpenAI-compatible gateway. Use `…/v1/messages` for Anthropic format. |
| `LLM_API_KEY` | `-` | API key for the gateway. `-` for unauth dev gateways. |
| `LLM_MODEL` | `MiniMax-M3` | Model name registered on the gateway |
| `LLM_SYSTEM_PROMPT` | `You are a helpful agent. Be concise.` | System prompt for P1 / REPL |
| `LLM_MAX_TOKENS` | `1024` | Max output tokens per LLM call |
| `LLM_TIMEOUT_MS` | `30000` | Per-call timeout |

To run **without** an LLM (echo-only P1, deterministic P2/P3), set
`LLM_BASE_URL=` to empty in the config or pass a config with `llm: undefined`
to `startServer()` in your test harness.

## Diagnosing integration: `GET /__diag`

`self_test` proves the protocol is correct, but the only proof a real
Finch platform is calling you is *them actually calling you*. The
provider exposes a local diagnostic endpoint for exactly this:

```bash
curl http://127.0.0.1:28894/__diag | jq
```

Returns a JSON snapshot of:

| Field | What it tells you |
|---|---|
| `total_requests` | Anything > 1 (after you've curled `/__diag` once) means the server has been hit. |
| `verify_success` / `verify_failure.{reason}` | Counters per failure mode — `missing_header` vs `bad_signature` vs `skew` vs `replay` vs `empty_nonce`. After pointing a tunnel at this provider, watch this for spikes while you trigger a test invocation from the Finch workspace. |
| `last_p2_poll_at` | The single most useful field for async tasks. Stays `null` until the platform GETs `/tasks/{id}` to poll your task. If you returned 202 for a P2 task and this is `null` 60s later, the platform isn't polling you. |
| `last_invocation_id` | The most recent `invocation_id` parsed from the request body. Useful to correlate with a test you fired from the workspace. |
| `last_platform_ts` | Wall-clock from the platform's `X-Platform-Timestamp`. Compare with `Date.now()` — large gaps mean clock skew (the protocol rejects >300s). |
| `recent[].{ts,method,path,status,verify,invocation_id}` | The last 50 requests, newest first. Bounded ring buffer. |
| `ever_called_from_remote` | `true` if anyone with a non-loopback address has ever hit the server. Stays `false` for purely local tests; flips on the first real platform call. |

The endpoint has **no auth** — `127.0.0.1`-only by convention. Gate
behind a network ACL or admin token before deploying publicly.

There is a `test/diag_test.ts` that drives the snapshot end-to-end
(6/6) to confirm the counters move correctly under each failure mode.

## Why pi-ai + pi-agent-core?

`@earendil-works/pi-ai` unifies OpenAI / Anthropic / Google / Bedrock behind
one `models.complete(model, ctx, opts)` call. The provider is auto-discovered
from `baseUrl` (it includes `/v1/messages` or `anthropic` → Anthropic format,
else OpenAI format). `@earendil-works/pi-agent-core` gives a stateful agent
loop (we use a hand-written one in `src/agent.ts` because the protocol wants
specific message shapes; pi-agent-core is still useful for
`pi-coding-agent`-style setups and is included as a dependency).

## Production checklist

- [ ] Send async callbacks (not implemented in the mock; use a worker queue)
- [ ] Persist the DB to durable storage (the `node:sqlite` file is fine for a
      single instance; use Postgres for HA)
- [ ] Add request-level schema validation (zod / typebox) for the Finch v2
      envelope — the Python mock validates by hand; for production prefer
      generated types from the JSON Schema Finch publishes
- [ ] Rate-limit `/invoke` (token bucket per merchant_task_id)
- [ ] Rotate keys via the Finch workspace, not via env

## See also

- `../finch-v2-mock-agent/` — the official Python reference (this TS port is
  a 1:1 mirror, verified per-file in `VERIFICATION.md`)
- `../finch-v2-mock-agent/SOURCE.md` — annotated walkthrough of the Python
  mock
- `../../../VERIFICATION.md` (in repo root) — drift-detection baseline
