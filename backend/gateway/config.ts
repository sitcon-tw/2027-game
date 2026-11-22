import { isIPv4 } from 'node:net';
import { readFile } from 'node:fs/promises';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';

export const loopback = '127.0.0.1';
export const workerPort = 18787;

export class ConfigError extends Error {}

export function isPrivateIPv4(address: string) {
  if (!isIPv4(address)) return false;
  const [first, second] = address.split('.', 2).map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
}

export function isAllowedPeer(address: string | undefined, privateNetwork: boolean) {
  if (!address) return false;
  return address === '::1' || (address.startsWith('127.') && isIPv4(address)) ||
    (privateNetwork && isPrivateIPv4(address));
}

function portNumber(text: string, key: string) {
  // Dart int.tryParse also accepts a sign and hexadecimal notation.
  const value = /^([+-]?)(0x[0-9a-f]+|[0-9]+)$/i.exec(text.trim());
  const port = value ? Number(value[2]) * (value[1] === '-' ? -1 : 1) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${key} must be an integer from 1 to 65535`);
  }
  return port;
}

export interface PublicConfig {
  port: number;
  dashboardPort: number;
  dashboardOrigin?: string;
}

export function publicConfig(env: NodeJS.ProcessEnv): PublicConfig {
  const port = portNumber(env.PORT ?? '8787', 'PORT');
  if (port === workerPort) {
    throw new ConfigError('PORT must differ from the internal worker port');
  }
  const dashboardPort = portNumber(env.DASHBOARD_PORT ?? '4173', 'DASHBOARD_PORT');
  const dashboardOrigin = env.DASHBOARD_ORIGIN || undefined;
  if (dashboardOrigin) {
    const origin = URL.parse(dashboardOrigin);
    if (!origin || origin.protocol !== 'https:' ||
        origin.origin !== dashboardOrigin || origin.hostname.includes('*') ||
        origin.port === '0') {
      throw new ConfigError('DASHBOARD_ORIGIN must be a canonical HTTPS origin without userinfo, path, query or fragment');
    }
  }
  return { port, dashboardPort, dashboardOrigin };
}

export async function postgresConfig(env: NodeJS.ProcessEnv) {
  const { POSTGRES_HOST: host, POSTGRES_DATABASE: database, POSTGRES_USER: user,
    POSTGRES_PASSWORD_FILE: file, POSTGRES_TLS: tls = 'verify-full' } = env;
  if (!host || host.startsWith('/') || !database || !user || !file ||
      (tls !== 'disable' && tls !== 'verify-full')) {
    throw new ConfigError('Invalid PostgreSQL configuration');
  }
  const password = (await readFile(file, 'utf8')).trimEnd();
  if (!password) throw new ConfigError('PostgreSQL password file is empty');
  return {
    host, database, user, password, port: portNumber(env.POSTGRES_PORT ?? '5432', 'POSTGRES_PORT'),
    ssl: tls === 'disable' ? false as const : {
      rejectUnauthorized: true,
      // Verify the configured host explicitly, including IPv4/IPv6 addresses.
      checkServerIdentity: (_hostname: string, certificate: PeerCertificate) => checkServerIdentity(host, certificate),
    },
    max: 1,
    connectionTimeoutMillis: 3000,
    statement_timeout: 3000,
    query_timeout: 4000,
  };
}
