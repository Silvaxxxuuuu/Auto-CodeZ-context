import { lookup } from 'node:dns/promises';
import net from 'node:net';

export type ResolvedWebAddress = { address: string; family: number };
export type WebHostResolver = (hostname: string) => Promise<ResolvedWebAddress[]>;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'metadata.google.internal',
  'metadata.google',
  'instance-data.ec2.internal',
]);

function stripIpv6Brackets(value: string): string {
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function ipv4Number(address: string): number | undefined {
  const parts = address.split('.');
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return (((octets[0] << 24) >>> 0) + (octets[1] << 16) + (octets[2] << 8) + octets[3]) >>> 0;
}

function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4Number(base);
  if (baseValue === undefined) return true;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (baseValue & mask);
}

function isUnsafeIpv4(address: string): boolean {
  const value = ipv4Number(address);
  if (value === undefined) return true;
  const blocked: Array<[string, number]> = [
    ['0.0.0.0', 8],
    ['10.0.0.0', 8],
    ['100.64.0.0', 10],
    ['127.0.0.0', 8],
    ['169.254.0.0', 16],
    ['172.16.0.0', 12],
    ['192.0.0.0', 24],
    ['192.0.2.0', 24],
    ['192.168.0.0', 16],
    ['198.18.0.0', 15],
    ['198.51.100.0', 24],
    ['203.0.113.0', 24],
    ['224.0.0.0', 4],
    ['240.0.0.0', 4],
  ];
  return blocked.some(([base, prefix]) => inIpv4Range(value, base, prefix));
}

function isUnsafeIpv6(address: string): boolean {
  const normalized = stripIpv6Brackets(address).split('%')[0].toLowerCase();
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  if (normalized.startsWith('ff')) return true;
  if (normalized === '2001:db8' || normalized.startsWith('2001:db8:')) return true;
  if (normalized.startsWith('::ffff:')) {
    const mapped = normalized.slice('::ffff:'.length);
    if (net.isIP(mapped) === 4) return isUnsafeIpv4(mapped);
  }
  return false;
}

export function isUnsafeWebAddress(address: string): boolean {
  const normalized = stripIpv6Brackets(address.trim());
  const family = net.isIP(normalized);
  if (family === 4) return isUnsafeIpv4(normalized);
  if (family === 6) return isUnsafeIpv6(normalized);
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = stripIpv6Brackets(hostname).toLowerCase().replace(/\.$/, '');
  if (BLOCKED_HOSTNAMES.has(normalized)) return true;
  return normalized.endsWith('.localhost')
    || normalized.endsWith('.local')
    || normalized.endsWith('.internal')
    || normalized.endsWith('.home.arpa');
}

export const defaultWebHostResolver: WebHostResolver = async (hostname) => {
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return resolved.map((entry) => ({ address: entry.address, family: entry.family }));
};

export async function assertPublicWebUrl(input: string | URL, resolver: WebHostResolver = defaultWebHostResolver): Promise<URL> {
  let url: URL;
  try {
    url = input instanceof URL ? new URL(input.toString()) : new URL(input);
  } catch {
    throw new Error('URL web inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Acesso web aceita somente HTTP ou HTTPS.');
  if (url.username || url.password) throw new Error('URLs web com credenciais embutidas não são permitidas.');

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  if (!hostname || isBlockedHostname(hostname)) throw new Error('O endereço web aponta para uma rede local ou reservada.');

  const literalFamily = net.isIP(hostname);
  if (literalFamily) {
    if (isUnsafeWebAddress(hostname)) throw new Error('O endereço web aponta para uma rede local ou reservada.');
    return url;
  }

  const addresses = await resolver(hostname);
  if (!addresses.length) throw new Error('O domínio web não resolveu para um endereço utilizável.');
  for (const resolved of addresses) {
    if ((resolved.family !== 4 && resolved.family !== 6) || isUnsafeWebAddress(resolved.address)) {
      throw new Error('O domínio web resolveu para uma rede local ou reservada.');
    }
  }
  return url;
}
