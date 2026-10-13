import { lookup } from 'node:dns/promises';
import { isIP, type LookupFunction } from 'node:net';
import { Agent, fetch as networkFetch, type BodyInit } from 'undici';
import ipaddr from 'ipaddr.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpTransportFactory } from './connections.js';

const globalV6 = ipaddr.parseCIDR('2000::/3');
const nat64 = ipaddr.parseCIDR('64:ff9b::/96');
const globalRanges = new Set([
  'unicast',
  'as112',
  'as112v6',
  'amt',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
]);

/** IANA globally reachable addresses, including public IPv4-mapped addresses. */
export function isPublicMcpAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, '');
  if (address.includes('%') || !isIP(address)) return false;
  const parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress())
      return isPublicMcpAddress(v6.toIPv4Address().toString());
    // A public NAT64 prefix must not translate to a private IPv4 destination.
    if (v6.match(nat64))
      return isPublicMcpAddress(v6.toByteArray().slice(-4).join('.'));
    if (['2001:1::1', '2001:1::2', '2001:1::3'].includes(v6.toString()))
      return true;
    return v6.match(globalV6) && globalRanges.has(v6.range());
  }
  // Globally reachable exceptions within the reserved protocol-assignment /24.
  if (['192.0.0.9', '192.0.0.10'].includes(parsed.toString())) return true;
  return globalRanges.has(parsed.range());
}

export async function resolvePublicMcpDestination(
  input: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Use a public HTTP(S) MCP endpoint without credentials.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  )
    throw new Error('MCP connections cannot access private network addresses.');
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await Promise.race([lookup(hostname, { all: true }), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
  signal.throwIfAborted();
  if (
    !addresses.length ||
    addresses.some((item) => !isPublicMcpAddress(item.address))
  )
    throw new Error('MCP connections cannot access private network addresses.');
  // Derive the family from each validated literal rather than trusting metadata.
  return {
    url,
    hostname,
    addresses: addresses.map(({ address }) => ({
      address,
      family: isIP(address),
    })),
  };
}

/** Public wallet users keep MCP features without access to the server's network. */
export function createPublicMcpFetch(signal: AbortSignal) {
  const agents = new Set<Agent>();
  const closed = new AbortController();
  const pinnedFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const bounded = AbortSignal.any([signal, closed.signal, request.signal]);
    const destination = await resolvePublicMcpDestination(request.url, bounded);
    bounded.throwIfAborted();
    const pinnedLookup: LookupFunction = (hostname, options, callback) => {
      if (hostname.toLowerCase() !== destination.hostname) {
        callback(new Error('MCP destination changed.'), []);
        return;
      }
      const family =
        options.family === 'IPv4'
          ? 4
          : options.family === 'IPv6'
            ? 6
            : options.family;
      const addresses = destination.addresses.filter(
        (item) => !family || family === item.family,
      );
      if (!addresses.length) {
        callback(new Error('MCP address family is unavailable.'), []);
        return;
      }
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    };
    // The original URL retains Host, SNI and certificate verification. The actual
    // socket lookup can return only these checked addresses, never a second DNS lookup.
    const agent = new Agent({
      connect: { lookup: pinnedLookup, timeout: 10000 },
    });
    agents.add(agent);
    const release = async () => {
      if (agents.delete(agent)) await agent.destroy();
    };
    try {
      const response = await networkFetch(destination.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body as unknown as BodyInit,
        duplex: 'half',
        signal: bounded,
        redirect: 'manual',
        dispatcher: agent,
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error(
          'MCP redirects are blocked. Use the final public endpoint URL.',
        );
      }
      if (!response.body) {
        await release();
        return response as unknown as Response;
      }
      // Release each private pool as soon as its body ends or is cancelled. SSE
      // remains streaming and close() can still terminate every active pool.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await reader.read();
            if (next.done) {
              controller.close();
              await release();
            } else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
            await release();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await release();
          }
        },
      });
      const result = new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: Object.fromEntries(response.headers),
      });
      Object.defineProperties(result, {
        url: { value: response.url },
        redirected: { value: response.redirected },
        type: { value: response.type },
      });
      return result;
    } catch (error) {
      await release();
      throw error;
    }
  };
  return { fetch: pinnedFetch, close: async () => {
    closed.abort(new Error('MCP connection closed.'));
    // destroy(), unlike graceful close(), also terminates unfinished SSE streams.
    await Promise.allSettled([...agents].map((agent) => agent.destroy()));
    agents.clear();
  }};
}

export const publicMcpTransport: McpTransportFactory = ({url, token, signal, authProvider}) => {
  const network = createPublicMcpFetch(signal);
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider,
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    fetch: network.fetch,
  });
  const close = transport.close.bind(transport);
  transport.close = async () => {
    try { await close(); } finally { await network.close(); }
  };
  return transport;
};
