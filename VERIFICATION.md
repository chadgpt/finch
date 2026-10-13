# VERIFICATION.md

Baseline integrity check between the **official Python example** distributed by
Finch and the **TypeScript port** in this repository. Run on 2026-10-13.

Use this file to detect drift after upstream updates:

```bash
# 1. Re-download the official mock
curl -sSL -o /tmp/finch.zip https://www.finchtech.ai/downloads/finch-v2-mock-agent.zip

# 2. Compare against baseline
diff <(sha256sum /tmp/finch.zip | awk '{print $1}') \
     <(awk '/Official mock archive/ {print $3}' VERIFICATION.md) \
  && echo "MATCH" || echo "DRIFT — re-port the Python example"
```

---

## 1. Upstream artifacts (one-time snapshot)

| Artifact | Source | Captured | SHA-256 |
|---|---|---|---|
| Official mock archive | `https://www.finchtech.ai/downloads/finch-v2-mock-agent.zip` | 2026-10-13 | `e8c6e931d177df8ea7f34bfb3b681251890858a3af986cffa86c1399b38cf66f` |
| `deployed-python-mock/app.py` | extracted from archive | 2026-10-13 | `4db76eab675fce41f7004af62f356a008189c88e707c5f7fb4ae42a48a013f4f` |
| Official `SOURCE.md` claim | `app.py` last-modified | per official | `2026-09-05 09:51:38 UTC` |
| Official `VERIFICATION.txt` | validation performed on | per official | `2026-09-18` |
| Docs page | `https://www.finchtech.ai/market/agents/docs` | linked | `/downloads/finch-v2-mock-agent.zip` (same URL) |

The `app.py` SHA-256 above is the value the official `SOURCE.md` claims for the
source deployed on the GCP VM `agent-runtime-finch-nerya` (path
`/opt/finch-async-mock/app.py`). The packaged copy is byte-for-byte identical
to the deployed source.

## 2. Per-file baseline (every file in the official mock)

| Path | SHA-256 |
|---|---|
| `README.md` | `8f370bb1f46d1c7de492ba284615b4f3a7b56eb1cf72a110e490ab52cf7663b5` |
| `SOURCE.md` | `c001c55b2acf81ea01fe917419da258e74c4ff2bed832e06f4ebda7fabcc23ff` |
| `VERIFICATION.txt` | `6281989828a4c9dc552e6373ba9dcbf2865a6eef1297e9b6dc364ea86c95ddf3` |
| `deployed-python-mock/.env.example` | `0282e9769a42a881d93b02fd086cf9a5e88902c475a46048ba6941b673dd4906` |
| `deployed-python-mock/app.py` | `4db76eab675fce41f7004af62f356a008189c88e707c5f7fb4ae42a48a013f4f` |
| `deployed-python-mock/self_test.py` | `c4364e9b8474c0be8abe15fce11aa44722837d88d0bc96fefd2cfc7c1933336b` |
| `node-protocol-fixture/config.example.json` | `9d477995355af3dae20463e4c934b800d360ecce8a58d1d9318dd80545152ca1` |
| `node-protocol-fixture/merchant-server.mjs` | `02ee41aef30db741ab683754803fd4a68613086fd9c299bc7fee21aa9dcbdbe6` |
| `node-protocol-fixture/merchant.mjs` | `c306175ff721870d64551af61dc1fd7ad0565a998b35b36c401b5f8fa404cbe2` |
| `node-protocol-fixture/test-runtime.mjs` | `b02c6dc99ff97731a35e45f06c392b1ba4e6faea829a829f21d7c5c7982079a1` |

## 3. TypeScript port 1:1 mirror mapping

`examples/finch-v2-mock-agent-typescript/src/provider.ts` mirrors
`deployed-python-mock/app.py` line-for-line. The two HMAC sign functions are
the canonical reference — they must stay identical:

**Python `Handler._sign` (lines 53-57 of `app.py`):**

```python
def _sign(secret: bytes, method: str, path: str, timestamp: str, nonce: str, body: bytes) -> str:
    canonical = "\n".join(
        (method.upper(), path, timestamp, nonce, hashlib.sha256(body).hexdigest())
    )
    return "v1=" + hmac.new(secret, canonical.encode(), hashlib.sha256).hexdigest()
```

**TypeScript `sign` in `src/provider.ts`:**

```typescript
function sign(secret, method, path, timestamp, nonce, body): string {
  const canonical = [
    method.toUpperCase(), path, timestamp, nonce, sha256Hex(body),
  ].join('\n');
  return 'v1=' + createHmac('sha256', secret).update(canonical).digest('hex');
}
```

| Python `Handler` method | TypeScript function in `provider.ts` |
|---|---|
| `_sign` | `sign` |
| `_body_sha256` | `sha256Hex` |
| `_verify_platform` | `verifyPlatform` |
| `_write_signed` | `writeSignedTo` |
| `_read_body` | `readBody` |
| `_deny` | `deny` |
| `do_GET` | `handleGet` (dispatches `/health`, `/tasks/{id}`) |
| `do_POST` | `handlePost` (dispatches `/invoke`, `/tasks/{id}/messages`, `/tasks/{id}/cancel`) |
| `_invoke` | `handleInvoke` |
| `_upload_slots` | `uploadSlots` |
| `_snapshot` | `taskSnapshot` |
| `_poll` | `handlePoll` |
| `_messages` | `handleMessages` |
| `_cancel` | `handleCancel` |

## 4. Drift detection workflow

When the user reports a new mock version (or Vercel returns a new
`Last-Modified` header that hints at a republish):

1. Download: `curl -sSL -o /tmp/finch.zip https://www.finchtech.ai/downloads/finch-v2-mock-agent.zip`
2. Hash: `sha256sum /tmp/finch.zip`
3. Compare with row 1 of section 1.
4. If it differs:
   - Re-extract to a temp dir, list new/changed files
   - Re-run `python3 deployed-python-mock/self_test.py` against the new mock
   - Re-port any new behavior into `examples/finch-v2-mock-agent-typescript/`
   - Update this `VERIFICATION.md` baseline in the same commit as the port
5. If it matches: nothing to do.

## 5. Caveats

- The `app.py` last-modified timestamp comes from `SOURCE.md`, not from
  `Last-Modified` HTTP headers (Vercel may re-zip without changing contents —
  the zip SHA-256 is the authoritative check).
- The Node `protocol-fixture/` files are an *independent* test surface (a
  Vitest suite) maintained by Finch, not part of the Python reference. Drift
  there does not require porting the TS example.
- The TS port adds features the Python mock intentionally omits: `node:sqlite`
  persistence, real LLM integration via the `openai` SDK, and a cross-runtime
  test harness. These are *additive*, not protocol drift.
