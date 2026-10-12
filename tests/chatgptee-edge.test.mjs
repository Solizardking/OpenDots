import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../deployment/chatgptee-edge.mjs';

const { Request, Response, ReadableStream, TextEncoder, TextDecoder } =
  globalThis;
const proxySecret = 'a'.repeat(48);
function environment(overrides = {}) {
  return {
    APP_UPSTREAM: 'https://chatgptee-production.up.railway.app',
    PRIVY_AUTH_ORIGIN: 'https://privy.chatgptee.ai',
    CHATGPTEE_PROXY_SECRET: proxySecret,
    BRAND_ASSETS: {
      fetch: vi.fn(() => Promise.resolve(new Response('asset'))),
    },
    ...overrides,
  };
}
function request(path = '/api/auth/get-session', headers = {}) {
  return new Request(`https://chatgptee.ai${path}`, {
    headers: { 'cf-connecting-ip': '203.0.113.24', ...headers },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('ChatGPTEE edge proxy trust boundary', () => {
  it('overwrites private headers and removes caller-provided forwarded IP chains', async () => {
    const fetcher = vi.fn(async (upstream) => {
      expect(upstream.url).toBe(
        'https://chatgptee-production.up.railway.app/api/auth/get-session',
      );
      expect(upstream.headers.get('x-chatgptee-client-ip')).toBe(
        '203.0.113.24',
      );
      expect(upstream.headers.get('x-chatgptee-proxy-secret')).toBe(
        proxySecret,
      );
      for (const header of [
        'forwarded',
        'x-forwarded-for',
        'x-real-ip',
        'cf-connecting-ip',
        'cf-connecting-ipv6',
        'true-client-ip',
        'x-vercel-forwarded-for',
        'x-client-ip',
      ])
        expect(upstream.headers.has(header)).toBe(false);
      return new Response('ok');
    });
    vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(
      request('/api/auth/get-session', {
        forwarded: 'for=198.51.100.7',
        'x-forwarded-for': '198.51.100.7, 198.51.100.8',
        'x-real-ip': '198.51.100.7',
        'cf-connecting-ipv6': '2001:db8::bad',
        'true-client-ip': '198.51.100.7',
        'x-vercel-forwarded-for': '198.51.100.7',
        'x-client-ip': '198.51.100.7',
        'x-chatgptee-client-ip': '198.51.100.7',
        'x-chatgptee-proxy-secret': 'spoofed',
      }),
      environment(),
    );
    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([
    ['/api/auth', { CHATGPTEE_PROXY_SECRET: undefined }, '203.0.113.24'],
    [
      '/api/auth/get-session',
      { CHATGPTEE_PROXY_SECRET: 'short' },
      '203.0.113.24',
    ],
    ['/api/auth/callback/google', {}, undefined],
    ['/api/auth/solana/verify', {}, '203.0.113.24, 198.51.100.7'],
    ['/api/auth/hybrid/privy', {}, ''],
  ])('rejects missing edge trust inputs on %s', async (path, overrides, ip) => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const incoming = request(path);
    if (ip === undefined) incoming.headers.delete('cf-connecting-ip');
    else incoming.headers.set('cf-connecting-ip', ip);
    // Caller-controlled substitutes never satisfy the edge IP requirement.
    incoming.headers.set('x-forwarded-for', '203.0.113.24');
    incoming.headers.set('x-chatgptee-client-ip', '203.0.113.24');
    incoming.headers.set('x-chatgptee-proxy-secret', proxySecret);
    const response = await worker.fetch(incoming, environment(overrides));
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toEqual({
      error: 'Authentication is temporarily unavailable.',
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves cookies, origin, POST body, streaming, and the origin security policy', async () => {
    let controller;
    const body = new ReadableStream({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode('data: first\n\n'));
      },
    });
    const fetcher = vi.fn(async (upstream, options) => {
      expect(upstream.method).toBe('POST');
      expect(upstream.headers.get('Cookie')).toBe('chatgptee.session_token=qa');
      expect(upstream.headers.get('Origin')).toBe('https://chatgptee.ai');
      expect(upstream.headers.get('Authorization')).toBe('Bearer fixture');
      expect(upstream.headers.get('x-chatgptee-client-ip')).toBe(
        '2001:db8::24',
      );
      expect(await upstream.text()).toBe('{"message":"hello"}');
      expect(options.redirect).toBe('manual');
      expect(options.cf.cacheTtlByStatus).toEqual({ '100-599': -1 });
      return new Response(body, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Set-Cookie': 'chatgptee.session_token=next; Secure; HttpOnly',
          'Content-Security-Policy':
            "default-src 'self'; connect-src 'self'; frame-src https://auth.privy.io; img-src 'self'; frame-ancestors 'none'",
          'x-chatgptee-proxy-secret': proxySecret,
          'x-chatgptee-client-ip': '2001:db8::24',
        },
      });
    });
    vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(
      new Request('https://chatgptee.ai/api/copilotkit', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '2001:db8::24',
          Cookie: 'chatgptee.session_token=qa',
          Origin: 'https://chatgptee.ai',
          Authorization: 'Bearer fixture',
          'Content-Type': 'application/json',
        },
        body: '{"message":"hello"}',
      }),
      environment(),
    );
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Set-Cookie')).toBe(
      'chatgptee.session_token=next; Secure; HttpOnly',
    );
    expect(response.headers.get('Cache-Control')).toBe(
      'no-store, no-transform',
    );
    expect(response.headers.has('x-chatgptee-proxy-secret')).toBe(false);
    expect(response.headers.has('x-chatgptee-client-ip')).toBe(false);
    const policy = response.headers.get('Content-Security-Policy');
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("connect-src 'self' https://privy.chatgptee.ai");
    expect(policy).toContain(
      'frame-src https://auth.privy.io https://privy.chatgptee.ai',
    );
    expect(policy).toContain("img-src 'self' https://privy.chatgptee.ai");
    // Read the first SSE event while its upstream stream is still open.
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe('data: first\n\n');
    controller.enqueue(new TextEncoder().encode('data: second\n\n'));
    controller.close();
    const second = await reader.read();
    expect(new TextDecoder().decode(second.value)).toBe('data: second\n\n');
    expect((await reader.read()).done).toBe(true);
  });

  it('retains immutable asset caching and strips spoofed private headers from non-auth requests', async () => {
    const fetcher = vi.fn(async (upstream) => {
      expect(upstream.headers.has('x-chatgptee-proxy-secret')).toBe(false);
      expect(upstream.headers.has('x-chatgptee-client-ip')).toBe(false);
      expect(upstream.headers.has('x-forwarded-for')).toBe(false);
      return new Response('compiled asset');
    });
    vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(
      new Request('https://chatgptee.ai/assets/client.js', {
        headers: {
          'x-forwarded-for': '198.51.100.7',
          'x-chatgptee-client-ip': '198.51.100.7',
          'x-chatgptee-proxy-secret': 'spoofed',
        },
      }),
      environment({ CHATGPTEE_PROXY_SECRET: undefined }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe(
      'public, max-age=31536000, immutable, no-transform',
    );
  });

  it.each(['/logo.png', '/agent/SKILL.md', '/agent/chatgptee-agent-0.1.1.tgz'])(
    'preserves public brand assets at %s without proxy credentials',
    async (path) => {
      const fetcher = vi.fn();
      vi.stubGlobal('fetch', fetcher);
      const env = environment({ CHATGPTEE_PROXY_SECRET: undefined });
      const response = await worker.fetch(
        new Request(`https://chatgptee.ai${path}`),
        env,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('asset');
      expect(response.headers.get('Cache-Control')).toBe(
        'public, max-age=3600, must-revalidate',
      );
      expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
      if (path.endsWith('.tgz'))
        expect(response.headers.get('Content-Type')).toBe('application/gzip');
      expect(env.BRAND_ASSETS.fetch).toHaveBeenCalledOnce();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it('preserves www redirects before auth configuration checks', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await worker.fetch(
      new Request('https://www.chatgptee.ai/api/auth/get-session?refresh=1'),
      environment({ CHATGPTEE_PROXY_SECRET: undefined }),
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(
      'https://chatgptee.ai/api/auth/get-session?refresh=1',
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
});
