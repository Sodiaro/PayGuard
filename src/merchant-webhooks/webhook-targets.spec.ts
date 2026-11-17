import { describe, expect, it } from '@jest/globals';
import { isPublicAddress, webhookUrlProblem } from './webhook-targets.js';

describe('webhook target policy', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '2606:4700:4700::1111',
    '::ffff:8.8.8.8',
  ])('treats %s as public', (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fe80::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    'not-an-address',
  ])('treats %s as not public', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it('accepts public https URLs', () => {
    expect(
      webhookUrlProblem('https://hooks.example.com/payguard?x=1', false),
    ).toBeNull();
    expect(webhookUrlProblem('https://8.8.8.8:8443/hook', false)).toBeNull();
  });

  it.each([
    ['not a URL', 'hooks.example.com/payguard', /absolute URL/],
    ['plain http', 'http://hooks.example.com', /https/],
    ['another scheme', 'ftp://hooks.example.com', /https/],
    ['credentials', 'https://user:pass@hooks.example.com', /credentials/],
    ['a fragment', 'https://hooks.example.com/#x', /fragment/],
    ['localhost', 'https://localhost/hook', /local or private/],
    ['a .localhost name', 'https://app.localhost/hook', /local or private/],
    ['a loopback address', 'https://127.0.0.1/hook', /local or private/],
    ['a metadata address', 'https://169.254.169.254/', /local or private/],
    ['an IPv6 loopback', 'https://[::1]/hook', /local or private/],
    [
      'an overlong URL',
      `https://hooks.example.com/${'a'.repeat(2048)}`,
      /at most 2048/,
    ],
  ])('rejects %s', (_case, url, message) => {
    expect(webhookUrlProblem(url, false)).toMatch(message);
  });

  it('allows http and local targets only when private targets are allowed', () => {
    expect(webhookUrlProblem('http://127.0.0.1:4000/hook', true)).toBeNull();
    expect(webhookUrlProblem('http://localhost:4000/hook', true)).toBeNull();
    expect(webhookUrlProblem('ftp://127.0.0.1', true)).toMatch(/https/);
    expect(webhookUrlProblem('http://u:p@127.0.0.1', true)).toMatch(
      /credentials/,
    );
  });
});
