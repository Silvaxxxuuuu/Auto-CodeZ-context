const PRIVATE_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.lan'];

function ipv4Parts(hostname: string): number[] | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) return undefined;
  const parts = match.slice(1).map(Number);
  return parts.some((part) => part < 0 || part > 255) ? undefined : parts;
}

function isPrivateIpv4(hostname: string): boolean {
  const parts = ipv4Parts(hostname);
  if (!parts) return false;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a >= 224;
}

function isPrivateIpv6(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  if (host.startsWith('fc') || host.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(host)) return true;
  if (host.startsWith('::ffff:')) {
    const mapped = host.slice('::ffff:'.length);
    return isPrivateIpv4(mapped);
  }
  return false;
}

export function isPrivateExternalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost') return true;
  if (PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  return isPrivateIpv4(host) || isPrivateIpv6(host);
}

export function requirePublicExternalUrl(value: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('URL externa inválida.');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('URL externa inválida.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Somente URLs públicas HTTP(S) podem ser abertas externamente.');
  if (url.username || url.password) throw new Error('URLs externas com credenciais embutidas são bloqueadas.');
  if (isPrivateExternalHostname(url.hostname)) throw new Error('URLs locais ou de rede privada não podem ser abertas externamente.');
  url.hash = '';
  return url.toString();
}
