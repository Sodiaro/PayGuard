import { isIPv6 } from 'node:net';

// IPv6 clients are limited per /64, the smallest block normally assigned to one subscriber, so
// rotating addresses inside an allocation does not yield a fresh bucket each time. IPv4-mapped
// IPv6 addresses (::ffff:a.b.c.d) are treated as the IPv4 address they carry.
export function clientRateLimitKey(ip: string | undefined): string {
  if (!ip) return 'ip:unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return `ip:${mapped[1]}`;
  if (!isIPv6(ip)) return `ip:${ip}`;
  return `ip6:${expandIPv6(ip).slice(0, 4).join(':')}::/64`;
}

function expandIPv6(ip: string): string[] {
  const withoutZone = ip.split('%')[0];
  const [head, tail] = withoutZone.includes('::')
    ? withoutZone.split('::')
    : [withoutZone, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  const groups =
    tail === undefined
      ? left
      : [...left, ...Array<string>(missing).fill('0'), ...right];
  return groups.map((group) => (parseInt(group, 16) || 0).toString(16));
}
