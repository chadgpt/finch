# Source Provenance

Captured on 2026-09-18.

## Deployed Python Mock

- VM: `agent-runtime-finch-nerya` (GCP `finchip`, `europe-west4-a`).
- Source: `/opt/finch-async-mock/app.py`.
- Active v2 service: `finch-async-mock-v2.service`.
- Environment file on the VM: `/opt/finch-async-mock/v2.env` (NOT included).
- Loopback port: `28892`.
- Source last-modified timestamp: `2026-09-05 09:51:38 UTC`.
- Source SHA-256: `4db76eab675fce41f7004af62f356a008189c88e707c5f7fb4ae42a48a013f4f`.
- Packaged `app.py` is byte-for-byte identical to the deployed source. No changes were made to the remote service.

## Node Protocol Fixture

- Repository directory: `Finch-Site/apps/web/integration/agenton-test-merchant/`.
- Latest source-directory commit in the inspected checkout: `e56d29070f67d73ddabde313ae25209ab2269810`.
- Packaged runtime files: `merchant-server.mjs`, `merchant.mjs`, `test-runtime.mjs`.
- Original repository suites validated with:

```sh
FINCH_ENVIRONMENT=test pnpm --dir Finch-Site/apps/web exec vitest run \
  --config vitest.integration.config.ts \
  integration/agenton-test-merchant/merchant.test.ts \
  integration/agenton-test-merchant/test-runtime.test.ts
```

Result: 21 tests passed across 2 files. Original TypeScript test files, static TLS fixture material, node_modules, and deployment configuration are not included.

The added `self_test.py`, examples, and documentation are packaging aids, not historical deployed files.
