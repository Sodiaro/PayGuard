import { BlockList, isIP } from 'node:net';

export const MAX_WEBHOOK_URL_LENGTH = 2048;

// Addresses a merchant-supplied URL must never reach unless private targets are allowed: the
// API's own host, its network and cloud metadata services would otherwise be one webhook away.
const NON_PUBLIC = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv4');
}
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96],
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const) {
  NON_PUBLIC.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return false;
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) reaches the IPv4 address it embeds.
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address);
    if (mapped) return isPublicAddress(mapped[1]);
    return !NON_PUBLIC.check(address, 'ipv6');
  }
  return !NON_PUBLIC.check(address, 'ipv4');
}

// URL.hostname keeps the brackets around an IPv6 literal.
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1');
}

// Checks what can be known without resolving the host; the address it resolves to is checked when
// connecting (see WebhookDeliveryClient), which also covers a name that changes its address.
export function webhookUrlProblem(
  value: string,
  allowPrivateTargets: boolean,
): string | null {
  if (value.length > MAX_WEBHOOK_URL_LENGTH) {
    return `url must be at most ${MAX_WEBHOOK_URL_LENGTH} characters`;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'url must be an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'url must use https';
  }
  if (url.protocol === 'http:' && !allowPrivateTargets) {
    return 'url must use https';
  }
  if (url.username || url.password) {
    return 'url must not contain credentials';
  }
  if (url.hash) {
    return 'url must not contain a fragment';
  }
  if (!allowPrivateTargets) {
    const host = hostOf(url).toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
      return 'url must not point to a local or private address';
    }
    if (isIP(host) !== 0 && !isPublicAddress(host)) {
      return 'url must not point to a local or private address';
    }
  }
  return null;
}
