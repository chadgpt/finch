/**
 * Inputs: An absolute harness-owned config path, referenced TLS files, and the Local merchant server factory.
 * Outputs: A bounded standalone HTTPS AgentOn merchant process and one secret-free readiness record.
 * Role: Owns process startup and shutdown without exposing secrets through arguments, environment, or logs.
 */
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { createMerchantServer, parseConfig } from './merchant-server.mjs';

function fail(message) {
  throw new Error(message);
}

const MAX_CONFIG_BYTES = 65_536;
const MAX_TLS_FILE_BYTES = 65_536;

async function readBoundedRegularFile(path, maxBytes, errorPrefix) {
  let handle;
  try {
    handle = await open(path, 'r');
    const metadata = await handle.stat();
    if (!metadata.isFile()) fail(`${errorPrefix}_NOT_REGULAR`);
    if (metadata.size > maxBytes) fail(`${errorPrefix}_TOO_LARGE`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let total = 0;
    while (total < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, total, buffer.byteLength - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) fail(`${errorPrefix}_TOO_LARGE`);
    return buffer.subarray(0, total);
  } catch (error) {
    if (error instanceof Error && new RegExp(`^${errorPrefix}_[A-Z_]+$`).test(error.message)) throw error;
    fail(`${errorPrefix}_READ_FAILED`);
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function readConfig(configPath) {
  const bytes = await readBoundedRegularFile(configPath, MAX_CONFIG_BYTES, 'CONFIG');
  try {
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      fail('CONFIG_JSON_INVALID');
    }
    try {
      return JSON.parse(text);
    } catch {
      fail('CONFIG_JSON_INVALID');
    }
  } catch (error) {
    if (error instanceof Error && /^CONFIG_[A-Z_]+$/.test(error.message)) throw error;
    fail('CONFIG_JSON_INVALID');
  }
}

async function main() {
  const configIndex = process.argv.indexOf('--config');
  if (configIndex < 0 || configIndex + 1 >= process.argv.length || process.argv.length !== 4) {
    fail('USAGE: node merchant.mjs --config <path>');
  }
  const configPath = process.argv[configIndex + 1];
  if (!isAbsolute(configPath)) fail('CONFIG_PATH_MUST_BE_ABSOLUTE');
  const rawConfig = await readConfig(configPath);
  const config = parseConfig(rawConfig);
  const [cert, key] = await Promise.all([
    readBoundedRegularFile(config.tls.certificatePath, MAX_TLS_FILE_BYTES, 'TLS_CERTIFICATE'),
    readBoundedRegularFile(config.tls.privateKeyPath, MAX_TLS_FILE_BYTES, 'TLS_PRIVATE_KEY'),
  ]);
  let server;
  try {
    server = createMerchantServer(config, { cert, key });
  } catch {
    fail('TLS_CONFIGURATION_INVALID');
  }
  server.listen(config.listen.port, config.listen.hostname, () => {
    const address = server.address();
    if (!address || typeof address === 'string') fail('LISTEN_FAILED');
    process.stdout.write(`${JSON.stringify({
      event: 'ready',
      origin: `https://${config.listen.hostname === '::1' ? '[::1]' : config.listen.hostname}:${address.port}`,
    })}\n`);
  });
  const stop = () => {
    const forced = setTimeout(() => {
      server.closeAllConnections();
      process.exit(0);
    }, 250);
    forced.unref();
    server.close(() => {
      clearTimeout(forced);
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'MERCHANT_START_FAILED'}\n`);
  process.exitCode = 1;
});
