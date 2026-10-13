# finch docs with examples

Reference material for building Providers on [finchtech.ai](https://www.finchtech.ai).

## Layout

| Path | Source |
|---|---|
| `./docs` | Copied from <https://www.finchtech.ai/market/agents/docs> |
| `./examples/finch-v2-mock-agent` | Imported from <https://www.finchtech.ai/downloads/finch-v2-mock-agent.zip> (Python + Node fixtures) |
| `./examples/finch-v2-mock-agent-typescript` | TypeScript port of the Python mock, 1:1 functional equivalence, runs in Deno (no install) and Node 22+ |

The three resources are designed to be used together:

1. Read `./docs/README.md` for the protocol specification.
2. Read `examples/finch-v2-mock-agent/README.md` (the Python mock) for the canonical reference implementation that Finch themselves run on GCP.
3. Use `examples/finch-v2-mock-agent-typescript/` if you prefer TypeScript — the same wire behavior in a strict, zero-runtime-dependency, dual-runtime (Deno + Node) package.

## Quick start

### Deno (no `npm install`)

```bash
cd examples/finch-v2-mock-agent-typescript
deno task test      # 6/6 PASS, ephemeral keys, no Finch account needed
deno task start     # runs the provider on 127.0.0.1:28891
```

### Node 22+

```bash
cd examples/finch-v2-mock-agent-typescript
npm install
npm test
npm start
```

### Python (the official mock)

```bash
cd examples/finch-v2-mock-agent
python3 deployed-python-mock/self_test.py
MOCK_REQUEST_SECRET=... MOCK_KEY_ID=... python3 deployed-python-mock/app.py
```

## Reference research

External analyses (not part of this repo, but built on the same sources):

- **finchtech.ai 公司研报** · <https://s4z9o4cuqekfw.space.mcode.cn>
- **Finch Agent Integration Protocol 协议研报** · <https://6u8tvjn2o829u.space.mcode.cn>
- **finch v2 mock agent 真伪验证**(SHA-256 `4db76eab675fce41f7004af62f356a008189c88e707c5f7fb4ae42a48a013f4f`,byte-for-byte equal to GCP `agent-runtime-finch-nerya` deployed source)

## Provenance

| Item | Date | Method |
|---|---|---|
| `docs/README.md` (43 KB) | 2026-10-04 | `curl https://www.finchtech.ai/market/agents/docs` |
| `examples/finch-v2-mock-agent/` (25 KB) | 2026-10-04 | `curl https://www.finchtech.ai/downloads/finch-v2-mock-agent.zip`, SHA-256 verified against SOURCE.md |
| `examples/finch-v2-mock-agent-typescript/` (29 KB) | 2026-10-13 | Ported from the Python mock; verified 6/6 tests pass in Deno 2.9.7 and Node 22.19 |

## License

MIT — see [LICENSE](./LICENSE).
