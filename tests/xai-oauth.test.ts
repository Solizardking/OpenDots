import { expect, it } from 'vitest';
import {
  XaiAuthorizationError,
  XaiOAuth,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
} from '../src/server/xai-oauth.js';

const NOW = 1_700_000_000_000;
type Reply = { status: number; body: unknown };
function stub(
  handler: (url: string, fields: URLSearchParams) => Reply,
): typeof fetch {
  return (async (input: unknown, init?: { body?: unknown }) => {
    const fields = new URLSearchParams(String(init?.body ?? ''));
    const { status, body } = handler(String(input), fields);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
}
const deviceReply = {
  device_code: 'device-code-1',
  user_code: 'ABCD-EFGH',
  verification_uri: 'https://accounts.x.ai/oauth2/device',
  expires_in: 1800,
  interval: 5,
};

it('starts the device flow with the public client and scope', async () => {
  const oauth = new XaiOAuth(
    stub((url, fields) => {
      expect(url).toBe('https://auth.x.ai/oauth2/device/code');
      expect(fields.get('client_id')).toBe(XAI_OAUTH_CLIENT_ID);
      expect(fields.get('scope')).toBe(XAI_OAUTH_SCOPE);
      return { status: 200, body: deviceReply };
    }),
    () => NOW,
  );
  await expect(oauth.start()).resolves.toEqual({
    deviceCode: 'device-code-1',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://accounts.x.ai/oauth2/device',
    expiresAt: NOW + 1800_000,
    intervalMs: 5000,
  });
});

it('rejects a verification address outside xAI origins', async () => {
  const oauth = new XaiOAuth(
    stub(() => ({
      status: 200,
      body: { ...deviceReply, verification_uri: 'https://evil.example/device' },
    })),
    () => NOW,
  );
  await expect(oauth.start()).rejects.toBeInstanceOf(XaiAuthorizationError);
});

it('polls through pending and slow_down, then returns validated tokens', async () => {
  const replies: Reply[] = [
    { status: 400, body: { error: 'authorization_pending' } },
    { status: 400, body: { error: 'slow_down' } },
    {
      status: 200,
      body: {
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
        expires_in: 3600,
      },
    },
  ];
  const oauth = new XaiOAuth(
    stub((url, fields) => {
      expect(url).toBe('https://auth.x.ai/oauth2/token');
      expect(fields.get('grant_type')).toBe(
        'urn:ietf:params:oauth:grant-type:device_code',
      );
      expect(fields.get('device_code')).toBe('device-code-1');
      return replies.shift()!;
    }),
    () => NOW,
  );
  await expect(oauth.poll('device-code-1', 5000)).resolves.toEqual({
    status: 'pending',
    intervalMs: 5000,
  });
  await expect(oauth.poll('device-code-1', 5000)).resolves.toEqual({
    status: 'pending',
    intervalMs: 10000,
  });
  await expect(oauth.poll('device-code-1', 5000)).resolves.toEqual({
    status: 'authorized',
    tokens: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      tokenType: 'Bearer',
      expiresAt: NOW + 3600_000,
    },
  });
});

it('fails closed on denial, expiry, and malformed tokens', async () => {
  const denied = new XaiOAuth(
    stub(() => ({ status: 400, body: { error: 'access_denied' } })),
    () => NOW,
  );
  await expect(denied.poll('device-code-1', 5000)).rejects.toThrow(
    'declined',
  );
  const malformed = new XaiOAuth(
    stub(() => ({
      status: 200,
      body: { access_token: 'x', token_type: 'MAC', expires_in: 60 },
    })),
    () => NOW,
  );
  await expect(malformed.poll('device-code-1', 5000)).rejects.toBeInstanceOf(
    XaiAuthorizationError,
  );
});

it('refreshes with rotation and honors the expiry skew', async () => {
  const oauth = new XaiOAuth(
    stub((url, fields) => {
      expect(fields.get('grant_type')).toBe('refresh_token');
      expect(fields.get('refresh_token')).toBe('refresh-1');
      return {
        status: 200,
        body: {
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          token_type: 'Bearer',
          expires_in: 3600,
        },
      };
    }),
    () => NOW,
  );
  const current = {
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    tokenType: 'Bearer',
    expiresAt: NOW + 10_000,
  };
  // Inside the 30s skew the stored token is not handed out.
  expect(oauth.accessToken(current)).toBeUndefined();
  const next = await oauth.refresh(current);
  expect(next.accessToken).toBe('access-2');
  expect(next.refreshToken).toBe('refresh-2');
  expect(oauth.accessToken(next)).toBe('access-2');
  await expect(
    oauth.refresh({ accessToken: 'a', tokenType: 'Bearer', expiresAt: NOW }),
  ).rejects.toThrow('Reconnect xAI');
});
