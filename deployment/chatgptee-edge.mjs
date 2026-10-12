// Keep the existing Node backend and persistent storage on Railway.
// Cloudflare owns the public hostname and forwards requests without buffering SSE.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.hostname === 'www.chatgptee.ai') {
      url.hostname = 'chatgptee.ai';
      return Response.redirect(url.toString(), 308);
    }
    const agentAsset = [
      '/agent/SKILL.md',
      '/agent/chatgptee-agent-0.1.0.tgz',
      '/agent/chatgptee-agent-0.1.1.tgz',
    ].includes(url.pathname);
    if (url.pathname.startsWith('/agent/') && !agentAsset)
      return new Response('Not found.', { status: 404 });
    if (url.pathname === '/logo.png' || agentAsset) {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response('Method not allowed', {
          status: 405,
          headers: { Allow: 'GET, HEAD' },
        });
      }
      const response = await env.BRAND_ASSETS.fetch(request);
      const headers = new Headers(response.headers);
      if (url.pathname.endsWith('.tgz'))
        headers.set('Content-Type', 'application/gzip');
      headers.set('Cache-Control', 'public, max-age=3600, must-revalidate');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    }
    const proxySecret =
      typeof env.CHATGPTEE_PROXY_SECRET === 'string' &&
      env.CHATGPTEE_PROXY_SECRET.length >= 32
        ? env.CHATGPTEE_PROXY_SECRET
        : undefined;
    // Read the edge-provided address before removing all forwarded IP inputs.
    // The origin validates this single address after authenticating this hop.
    const edgeIp = request.headers.get('cf-connecting-ip')?.trim();
    const clientIp = edgeIp && !/[,\s]/.test(edgeIp) ? edgeIp : undefined;
    const authPath =
      url.pathname === '/api/auth' || url.pathname.startsWith('/api/auth/');
    if (authPath && (!proxySecret || !clientIp))
      return Response.json(
        { error: 'Authentication is temporarily unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    const upstream = new URL(env.APP_UPSTREAM);
    if (upstream.protocol !== 'https:')
      return Response.json(
        { error: 'The secure application origin is unavailable.' },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    url.protocol = upstream.protocol;
    url.hostname = upstream.hostname;
    url.port = upstream.port;
    const proxied = new Request(url, request);
    for (const header of [
      'forwarded',
      'x-forwarded-for',
      'x-real-ip',
      'cf-connecting-ip',
      'cf-connecting-ipv6',
      'true-client-ip',
      'x-vercel-forwarded-for',
      'x-client-ip',
      'x-chatgptee-client-ip',
      'x-chatgptee-proxy-secret',
    ])
      proxied.headers.delete(header);
    if (clientIp) proxied.headers.set('x-chatgptee-client-ip', clientIp);
    if (proxySecret)
      proxied.headers.set('x-chatgptee-proxy-secret', proxySecret);
    const response = await fetch(proxied, {
      redirect: 'manual',
      cf: { cacheTtlByStatus: { '100-599': -1 } },
    });
    const headers = new Headers(response.headers);
    // These headers authenticate the private origin hop and are never public.
    headers.delete('x-chatgptee-proxy-secret');
    headers.delete('x-chatgptee-client-ip');
    // Privy uses its own first-party subdomain. Preserve the origin's security
    // policy while allowing that configured login frame and API through it.
    const policy = headers.get('Content-Security-Policy');
    if (policy && env.PRIVY_AUTH_ORIGIN) {
      const privyOrigin = new URL(env.PRIVY_AUTH_ORIGIN).origin;
      if (!privyOrigin.startsWith('https://'))
        throw new Error('PRIVY_AUTH_ORIGIN must use HTTPS.');
      headers.set(
        'Content-Security-Policy',
        policy
          .split(';')
          .map((directive) => {
            const [name, ...sources] = directive.trim().split(/\s+/);
            if (
              ['connect-src', 'frame-src', 'img-src'].includes(name) &&
              !sources.includes(privyOrigin)
            )
              sources.push(privyOrigin);
            return [name, ...sources].join(' ');
          })
          .join('; '),
      );
    }
    headers.set(
      'Cache-Control',
      url.pathname.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable, no-transform'
        : 'no-store, no-transform',
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
