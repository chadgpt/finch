# Finch v2 Mock Agent

This bundle contains two existing mock implementations. It does not contain live credentials, wallet keys, database access, or deployment environment files.

## Contents

- `deployed-python-mock/app.py`: exact source copied from the running nerya VM on 2026-09-18. Start here for the async P2 example discussed in the support investigation.
- `deployed-python-mock/self_test.py`: standalone local smoke test using newly generated in-memory credentials and loopback HTTP only.
- `node-protocol-fixture/`: repository protocol fixture covering deterministic P1, P2, P3 and fault scenarios. It is an integration-test fixture, not a production agent SDK.
- `SOURCE.md`: source provenance and validation results.

## Run The Deployed Python Mock

Requires Python 3.9 or later. Only the Python standard library is used.

First run the local smoke test. No Finch account or secrets are needed:

```sh
python3 deployed-python-mock/self_test.py
```

For integration, set the following environment variables using the credentials for your OWN service version:

| Variable | Value |
| --- | --- |
| `MOCK_REQUEST_SECRET` | Standard Base64 encoding of the 32 raw Request secret bytes |
| `MOCK_CALLBACK_SECRET` | Standard Base64 encoding of the 32 raw Callback secret bytes |
| `MOCK_KEY_ID` | The credential key ID issued for your service version |
| `MOCK_PORT` | `28892`, or an available local port |
| `MOCK_AGENT_NAME` | `finch-async-mock-v2` |

```sh
python3 deployed-python-mock/app.py
```

On Windows, use `py -3` instead of `python3` and set environment variables in PowerShell. `.env.example` is a reference only; the server does not automatically load `.env` files.

FCR1 contains raw secret bytes. Base64-encode those bytes for these environment variables; do not use the Base64 text itself as the HMAC key. The server Base64-decodes the variables before signing.

The server binds to `127.0.0.1`. Put an HTTPS reverse proxy or tunnel in front of it for Finch. Preserve the exact signed request path and query string. Do not expose the local HTTP port directly.

Configure `wireProtocol: finch_v2` and the endpoints:

- Health: `https://YOUR-HOST/health`
- Invocation: `https://YOUR-HOST/invoke`
- Task base URL: `https://YOUR-HOST/tasks`

Use an Offer with `interactionMode: task` for P2.

## Behavior

- Signed `GET /health` returns `ready`.
- P1 `conversation_turn` returns a synchronous signed completed text response.
- P2/P3 invocation returns `202`, a stable `merchant_task_id`, and `poll_after_ms: 500`.
- P2 contract tests (`input.parameters.contract_test: true`) briefly return `working`, then `completed` without asking for input.
- Ordinary P2 tasks briefly return `working`, then `input_required`; `POST /tasks/{id}/messages` completes the task and echoes the user's answer.
- P3 uses the supplied artifact upload slots to upload deterministic text output. Its local smoke test validates upload behavior with a loopback sink, not a real Finch artifact receipt.

## Poll Snapshot Examples

These are shapes emitted by this mock. The task ID must match the accepted receipt.

Working:

```json
{
  "protocol_version": "2.0",
  "merchant_task_id": "mtk-example",
  "status": "working",
  "sequence": 1,
  "progress": { "percent": 10, "stage": "clarifying" }
}
```

Completed P2:

```json
{
  "protocol_version": "2.0",
  "merchant_task_id": "mtk-example",
  "status": "completed",
  "sequence": 2,
  "completed_at": "2026-09-18T06:33:10Z",
  "message": {
    "role": "agent",
    "content": [{ "type": "text", "text": "Mock task completed." }]
  },
  "artifacts": []
}
```

For strict `finch_v2`, omit unused optional fields instead of sending `null`. Do not add `invocation_id` to poll snapshots. Both UTC-second and fractional-second `completed_at` values are accepted by the production parser inspected during this investigation.

## Node Protocol Fixture

Requires Node.js 22 or later. Runtime files use only built-in Node modules.

`merchant.mjs` launches a local HTTPS fixture with an absolute JSON config path:

```sh
node node-protocol-fixture/merchant.mjs --config /ABSOLUTE/PATH/config.json
```

Copy `config.example.json` to a private path, supply your own TLS certificate/key paths and fixture credentials, and keep the file out of version control. The direct launcher is intentionally loopback-only, including allowed outbound origins. Its JSON credentials are UTF-8 fixture strings, NOT an encoded-secret importer; do not paste Base64-encoded live material into these fields expecting it to be decoded.

Routes are `/v1/health`, `/v1/invoke`, and `/v1/tasks/{merchant_task_id}`. `wireProtocol` defaults to `finch_v2`. For a successful P2 probe, use `scenario: success`. Other scenarios include `input`, `callback`, `replay`, `error`, `timeout`, and `invalid_output`.

`test-runtime.mjs` is the existing TEST-only deployment entrypoint. It requires `FINCH_ENVIRONMENT=test`, `FINCH_AGENT_MARKET_RUNTIME_PUBLIC_ORIGIN`, `FINCH_TEST_AGENTON_KEY_ID`, `FINCH_TEST_AGENTON_REQUEST_SECRET_BASE64`, and `FINCH_TEST_AGENTON_CALLBACK_SECRET_BASE64`, then runs with `--port PORT`. It uses `/test-merchants/agenton/v1/...` paths and the callback scenario. Do not use it as a production launcher.

## Limitations

These are mocks, not production reference servers. State is in memory and disappears on restart. The copied Python source does not send callbacks, does not fully validate incoming protocol schemas, and its cancel handler is not a complete terminal-state implementation. Do not use it as a cancellation reference. P3 uploads use a permissive test-only outbound implementation and deterministic text bytes; do not run the mock against untrusted callers or infer production upload security from it.

The packet shapes and signing flow are useful references, but a real provider must add durable state, proper idempotency, complete terminal transitions, secure outbound policy, and production authentication hardening. This bundle does not publish an Agent or replace the official contract tests.
