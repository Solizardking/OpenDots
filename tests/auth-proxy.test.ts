import { describe, expect, it } from 'vitest';
import {
  authClientIpHeader,
  authProxySecretHeader,
  trustedAuthHeaders,
} from '../src/server/auth-proxy.js';

const secret = 'test-origin-secret-abcdefghijklmnopqrstuvwxyz';
describe('auth origin and client IP trust', () => {
  it('requires origin authentication and exactly one IP before trusting edge headers', () => {
    const request = (ip: string, credential = secret) =>
      new Request('https://origin.test/api/auth/get-session', {
        headers: {
          [authProxySecretHeader]: credential,
          [authClientIpHeader]: ip,
        },
      });
    for (const ip of [
      '',
      'not-an-ip',
      '203.0.113.1, 203.0.113.2',
      '203.0.113.1:443',
      '[2001:db8::1]',
    ])
      expect(trustedAuthHeaders(request(ip), secret)).toBeUndefined();
    expect(
      trustedAuthHeaders(request('203.0.113.1', 'wrong'), secret),
    ).toBeUndefined();
    expect(
      trustedAuthHeaders(
        new Request('https://origin.test/api/auth/get-session'),
        secret,
      ),
    ).toBeUndefined();
    expect(
      trustedAuthHeaders(request('203.0.113.1'), secret)?.get(
        authClientIpHeader,
      ),
    ).toBe('203.0.113.1');
    expect(
      trustedAuthHeaders(request('2001:db8::1'), secret)?.get(
        authClientIpHeader,
      ),
    ).toBe('2001:db8::1');
  });
  it('removes credentials and alternative forwarding headers from Better Auth inputs', () => {
    const request = new Request('https://origin.test/api/auth/get-session', {
      headers: {
        [authProxySecretHeader]: secret,
        [authClientIpHeader]: '203.0.113.1',
        'cf-connecting-ip': '192.0.2.1',
        'x-forwarded-for': '192.0.2.2, 192.0.2.3',
        'x-real-ip': '192.0.2.4',
        'x-vercel-forwarded-for': '192.0.2.5',
        'true-client-ip': '192.0.2.6',
        forwarded: 'for=192.0.2.7',
        Cookie: 'fixture=cookie',
        Origin: 'https://chatgptee.ai',
      },
    });
    const headers = trustedAuthHeaders(request, secret)!;
    expect(headers.get(authClientIpHeader)).toBe('203.0.113.1');
    expect(headers.get('cookie')).toBe('fixture=cookie');
    expect(headers.get('origin')).toBe('https://chatgptee.ai');
    for (const name of [
      authProxySecretHeader,
      'cf-connecting-ip',
      'x-forwarded-for',
      'x-real-ip',
      'x-vercel-forwarded-for',
      'true-client-ip',
      'forwarded',
    ])
      expect(headers.has(name)).toBe(false);
  });
  it('uses the socket peer in local mode and ignores forged edge metadata', () => {
    const request = new Request('http://localhost/api/auth/get-session', {
      headers: {
        [authClientIpHeader]: '192.0.2.1',
        'cf-connecting-ip': '192.0.2.2',
        'x-forwarded-for': '192.0.2.3',
      },
    });
    expect(
      trustedAuthHeaders(request, undefined, '127.0.0.1')?.get(
        authClientIpHeader,
      ),
    ).toBe('127.0.0.1');
    expect(
      trustedAuthHeaders(request, undefined)?.has(authClientIpHeader),
    ).toBe(false);
  });
});
