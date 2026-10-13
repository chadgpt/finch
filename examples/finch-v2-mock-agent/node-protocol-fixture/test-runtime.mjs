/**
 * Inputs: TEST-only raw-byte AgentOn secrets, the runtime public HTTPS origin, and an explicit container port.
 * Outputs: A secret-safe HTTP merchant process reachable only through the TEST Caddy exact-path proxy.
 * Role: Adapts the external AgentOn fixture to the deployed TEST runtime without weakening production transport policy.
 */
import { createMerchantServer } from './merchant-server.mjs';

function fail(message) {
  throw new Error(message);
}

function parsePort(argv) {
  if (argv.length !== 2 || argv[0] !== '--port' || !/^\d{1,5}$/.test(argv[1])) {
    fail('TEST_AGENTON_PORT_INVALID');
  }
  const port = Number(argv[1]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) fail('TEST_AGENTON_PORT_INVALID');
  return port;
}

function parseOrigin(raw) {
  let origin;
  try {
    origin = new URL(raw);
  } catch {
    fail('TEST_AGENTON_RUNTIME_ORIGIN_INVALID');
  }
  if (origin.origin !== raw || origin.protocol !== 'https:' || origin.username ||
      origin.password || origin.hash || origin.pathname !== '/' || origin.search) {
    fail('TEST_AGENTON_RUNTIME_ORIGIN_INVALID');
  }
  return origin.origin;
}

function decodeSecret(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(raw)) {
    fail(`${name}_INVALID`);
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.byteLength !== 32 || bytes.toString('base64') !== raw) fail(`${name}_INVALID`);
  return bytes;
}

function parseKeyId(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(raw)) {
    fail('FINCH_TEST_AGENTON_KEY_ID_INVALID');
  }
  return raw;
}

if (process.env.FINCH_ENVIRONMENT !== 'test') fail('TEST_AGENTON_ENVIRONMENT_INVALID');

const port = parsePort(process.argv.slice(2));
const runtimeOrigin = parseOrigin(process.env.FINCH_AGENT_MARKET_RUNTIME_PUBLIC_ORIGIN);
const config = Object.freeze({
  listen: Object.freeze({ hostname: '0.0.0.0', port }),
  credentials: Object.freeze({
    keyId: parseKeyId(process.env.FINCH_TEST_AGENTON_KEY_ID),
    requestSecret: decodeSecret('FINCH_TEST_AGENTON_REQUEST_SECRET_BASE64'),
    callbackSecret: decodeSecret('FINCH_TEST_AGENTON_CALLBACK_SECRET_BASE64'),
  }),
  externalPathPrefix: '/test-merchants/agenton',
  scenario: 'callback',
  allowedOutboundOrigins: Object.freeze([runtimeOrigin]),
  timeoutDelayMs: 250,
  callbackDelayMs: 10,
});

const server = createMerchantServer(config);
server.on('error', (error) => {
  process.stderr.write(`TEST_AGENTON_MERCHANT_FAILED:${error instanceof Error ? error.message : 'UNKNOWN'}\n`);
  process.exitCode = 1;
});
server.listen(port, '0.0.0.0', () => {
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;
  process.stdout.write(`TEST_AGENTON_MERCHANT_READY:${boundPort}\n`);
});

function stop() {
  server.close(() => process.exit(0));
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
