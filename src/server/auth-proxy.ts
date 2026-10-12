import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const authClientIpHeader = 'x-chatgptee-client-ip';
export const authProxySecretHeader = 'x-chatgptee-proxy-secret';

export function trustedAuthHeaders(
  request: Request,
  secret: string | undefined,
  peerAddress?: string,
) {
  let clientIp: string | undefined;
  if (secret) {
    const supplied = Buffer.from(
      request.headers.get(authProxySecretHeader) ?? '',
    );
    const expected = Buffer.from(secret);
    if (
      supplied.length !== expected.length ||
      !timingSafeEqual(supplied, expected)
    )
      return undefined;
    clientIp = request.headers.get(authClientIpHeader)?.trim();
    if (!clientIp || !isIP(clientIp)) return undefined;
  } else {
    // Local/self-hosted mode uses the socket peer, never arbitrary forwarding headers.
    clientIp = peerAddress && isIP(peerAddress) ? peerAddress : undefined;
  }
  const headers = new Headers(request.headers);
  for (const name of [
    authProxySecretHeader,
    authClientIpHeader,
    'cf-connecting-ip',
    'x-forwarded-for',
    'x-real-ip',
    'x-vercel-forwarded-for',
    'true-client-ip',
    'forwarded',
  ])
    headers.delete(name);
  if (clientIp) headers.set(authClientIpHeader, clientIp);
  return headers;
}
