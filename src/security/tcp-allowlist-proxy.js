import net from 'node:net';

const UINT32_MAX = 0xFFFFFFFF;
const DEFAULT_MAX_CONNECTIONS = 128;
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

function configError(message, code = 'PROXY_CONFIG_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

export function normalizeIpv4(value = '') {
  const text = String(value || '').trim();
  const normalized = text.startsWith('::ffff:') ? text.slice(7) : text;
  return net.isIP(normalized) === 4 ? normalized : '';
}

export function ipv4ToInteger(value) {
  const normalized = normalizeIpv4(value);
  if (!normalized) throw configError(`Invalid IPv4 address: ${value}.`);
  return normalized.split('.').reduce((result, octet) => (
    ((result << 8) | Number.parseInt(octet, 10)) >>> 0
  ), 0);
}

export function parseIpv4Cidr(value) {
  const [addressText, prefixText] = String(value || '').trim().split('/');
  const address = normalizeIpv4(addressText);
  const prefix = Number.parseInt(prefixText, 10);
  if (!address || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    throw configError(`Invalid IPv4 CIDR: ${value}.`);
  }
  const mask = prefix === 0 ? 0 : (UINT32_MAX << (32 - prefix)) >>> 0;
  const network = ipv4ToInteger(address) & mask;
  return Object.freeze({
    source: `${address}/${prefix}`,
    address,
    prefix,
    mask,
    network,
  });
}

export function ipv4InCidr(address, cidr) {
  const parsed = typeof cidr === 'string' ? parseIpv4Cidr(cidr) : cidr;
  return (ipv4ToInteger(address) & parsed.mask) === parsed.network;
}

export function parseAllowedCidrs(value = '100.64.0.0/10') {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) throw configError('At least one allowed CIDR is required.');
  return items.map(parseIpv4Cidr);
}

export function parseTailnetAllowedHosts(value = '', allowedCidrs = parseAllowedCidrs()) {
  const items = String(value || '')
    .split(',')
    .map((item) => normalizeIpv4(item))
    .filter(Boolean);
  const unique = [...new Set(items)];
  for (const host of unique) {
    if (!allowedCidrs.some((cidr) => ipv4InCidr(host, cidr))) {
      throw configError(`Allowed proxy host is outside the tailnet CIDR: ${host}.`);
    }
  }
  return Object.freeze(unique);
}

function normalizePort(value, label) {
  const port = Number.parseInt(String(value), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw configError(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function normalizePositiveInteger(value, fallback, label, maximum) {
  if (value == null || value === '') return fallback;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw configError(`${label} must be an integer between 1 and ${maximum}.`);
  }
  return parsed;
}

export function validateProxyConfig(input = {}) {
  const bindHost = normalizeIpv4(input.bindHost);
  if (!bindHost || bindHost === '0.0.0.0' || bindHost.startsWith('127.')) {
    throw configError('Proxy bind host must be one explicit non-loopback IPv4 address.');
  }
  const targetHost = normalizeIpv4(input.targetHost || '127.0.0.1');
  if (!targetHost || !targetHost.startsWith('127.')) {
    throw configError('Proxy target host must remain on IPv4 loopback.');
  }
  const allowedCidrs = parseAllowedCidrs(input.allowedCidrs);
  if (!allowedCidrs.some((cidr) => ipv4InCidr(bindHost, cidr))) {
    throw configError('Proxy bind host must belong to an allowed CIDR.');
  }
  return Object.freeze({
    bindHost,
    bindPort: normalizePort(input.bindPort || 3010, 'Proxy bind port'),
    targetHost,
    targetPort: normalizePort(input.targetPort || 3010, 'Proxy target port'),
    allowedCidrs,
    maxConnections: normalizePositiveInteger(
      input.maxConnections,
      DEFAULT_MAX_CONNECTIONS,
      'Proxy max connections',
      10_000,
    ),
    idleTimeoutMs: normalizePositiveInteger(
      input.idleTimeoutMs,
      DEFAULT_IDLE_TIMEOUT_MS,
      'Proxy idle timeout',
      24 * 60 * 60 * 1000,
    ),
  });
}

export function loadProxyConfig(env = process.env) {
  return validateProxyConfig({
    bindHost: env.MAIL_INTELLIGENCE_PROXY_BIND,
    bindPort: env.MAIL_INTELLIGENCE_PROXY_PORT,
    targetHost: env.MAIL_INTELLIGENCE_PROXY_TARGET_HOST,
    targetPort: env.MAIL_INTELLIGENCE_PROXY_TARGET_PORT,
    allowedCidrs: env.MAIL_INTELLIGENCE_PROXY_ALLOWED_CIDRS,
    maxConnections: env.MAIL_INTELLIGENCE_PROXY_MAX_CONNECTIONS,
    idleTimeoutMs: env.MAIL_INTELLIGENCE_PROXY_IDLE_TIMEOUT_MS,
  });
}

export function clientAddressAllowed(address, allowedCidrs) {
  const normalized = normalizeIpv4(address);
  if (!normalized) return false;
  return allowedCidrs.some((cidr) => ipv4InCidr(normalized, cidr));
}

function closeSocket(socket) {
  if (!socket.destroyed) socket.destroy();
}

export function createAllowlistedTcpProxy(input = {}) {
  const config = input.allowedCidrs?.[0]?.network != null
    ? Object.freeze({ ...input })
    : validateProxyConfig(input);
  const activeSockets = new Set();
  const server = net.createServer({ pauseOnConnect: true }, (client) => {
    const remoteAddress = normalizeIpv4(client.remoteAddress);
    if (!remoteAddress || !clientAddressAllowed(remoteAddress, config.allowedCidrs)) {
      closeSocket(client);
      return;
    }

    const upstream = net.createConnection({
      host: config.targetHost,
      port: config.targetPort,
    });
    activeSockets.add(client);
    activeSockets.add(upstream);
    client.setTimeout(config.idleTimeoutMs);
    upstream.setTimeout(config.idleTimeoutMs);

    const closePair = () => {
      closeSocket(client);
      closeSocket(upstream);
    };
    const forgetPair = () => {
      activeSockets.delete(client);
      activeSockets.delete(upstream);
    };

    client.once('timeout', closePair);
    upstream.once('timeout', closePair);
    client.once('error', closePair);
    upstream.once('error', closePair);
    client.once('close', forgetPair);
    upstream.once('close', forgetPair);
    upstream.once('connect', () => {
      client.pipe(upstream);
      upstream.pipe(client);
      client.resume();
    });
  });
  server.maxConnections = config.maxConnections;

  return Object.freeze({
    config,
    server,
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(server.address());
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.bindPort, config.bindHost);
      });
    },
    close() {
      for (const socket of activeSockets) closeSocket(socket);
      return new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  });
}
