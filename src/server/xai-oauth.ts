// xAI model OAuth: device authorization flow against auth.x.ai using the
// public Grok CLI client, so a user can connect their xAI account instead
// of pasting an XAI_API_KEY. This module only speaks the protocol: it
// returns tokens to the caller and never persists them. Storage, refresh
// scheduling and model wiring belong to the integrating server.
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const XAI_OAUTH_SCOPE =
  'openid profile email offline_access grok-cli:access api:access';
const DEVICE_CODE_URL = 'https://auth.x.ai/oauth2/device/code';
const TOKEN_URL = 'https://auth.x.ai/oauth2/token';
const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const VERIFICATION_ORIGINS = ['https://auth.x.ai', 'https://accounts.x.ai'];
const MAX_RESPONSE_BYTES = 64_000;
const EXPIRY_SKEW_MS = 30_000;

export interface XaiTokens {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  scope?: string;
  /** Epoch milliseconds after which the access token must not be used. */
  expiresAt: number;
}
export interface XaiDeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalMs: number;
}
export type XaiDevicePoll =
  | { status: 'pending'; intervalMs: number }
  | { status: 'authorized'; tokens: XaiTokens };

export class XaiAuthorizationError extends Error {}

type OAuthBody = Record<string, unknown>;

export class XaiOAuth {
  constructor(
    private request: typeof fetch = fetch,
    private now = Date.now,
  ) {}
  private async post(
    url: string,
    fields: Record<string, string>,
  ): Promise<{ status: number; body: OAuthBody }> {
    const response = await this.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES)
      throw new XaiAuthorizationError('xAI returned an oversized response.');
    let body: OAuthBody = {};
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        body = parsed as OAuthBody;
    } catch {
      /* Non-JSON bodies carry no fields; status handling below decides. */
    }
    return { status: response.status, body };
  }
  private tokens(body: OAuthBody, previousRefresh?: string): XaiTokens {
    const expiresIn = Number(body.expires_in);
    if (
      typeof body.access_token !== 'string' ||
      body.access_token.length < 1 ||
      body.access_token.length > 8192 ||
      typeof body.token_type !== 'string' ||
      body.token_type.toLowerCase() !== 'bearer' ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0 ||
      expiresIn > 31 * 86400
    )
      throw new XaiAuthorizationError('xAI returned an invalid token.');
    const refreshToken =
      typeof body.refresh_token === 'string' && body.refresh_token
        ? body.refresh_token
        : previousRefresh;
    return {
      accessToken: body.access_token,
      ...(refreshToken ? { refreshToken } : {}),
      tokenType: body.token_type,
      ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
      expiresAt: this.now() + expiresIn * 1000,
    };
  }
  async start(): Promise<XaiDeviceStart> {
    const { status, body } = await this.post(DEVICE_CODE_URL, {
      client_id: XAI_OAUTH_CLIENT_ID,
      scope: XAI_OAUTH_SCOPE,
    });
    const uri =
      typeof body.verification_uri === 'string'
        ? body.verification_uri
        : typeof body.verification_uri_complete === 'string'
          ? body.verification_uri_complete
          : typeof body.verification_url === 'string'
            ? body.verification_url
            : undefined;
    let verificationUri: string | undefined;
    try {
      const parsed = new URL(uri ?? '');
      if (VERIFICATION_ORIGINS.includes(parsed.origin) && !parsed.username)
        verificationUri = parsed.href;
    } catch {
      /* Rejected below with the other invalid fields. */
    }
    const deviceCode = body.device_code;
    const userCode = body.user_code;
    const expiresIn = Number(body.expires_in);
    const interval = Number(body.interval);
    if (
      status !== 200 ||
      typeof deviceCode !== 'string' ||
      !deviceCode ||
      typeof userCode !== 'string' ||
      !userCode ||
      !verificationUri ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    )
      throw new XaiAuthorizationError(
        'xAI device sign-in could not start. Please retry.',
      );
    return {
      deviceCode,
      userCode,
      verificationUri,
      expiresAt: this.now() + Math.min(expiresIn, 3600) * 1000,
      intervalMs:
        Number.isFinite(interval) && interval > 0
          ? Math.max(1000, interval * 1000)
          : 5000,
    };
  }
  async poll(
    deviceCode: string,
    intervalMs: number,
  ): Promise<XaiDevicePoll> {
    const { status, body } = await this.post(TOKEN_URL, {
      grant_type: DEVICE_GRANT,
      device_code: deviceCode,
      client_id: XAI_OAUTH_CLIENT_ID,
    });
    if (status === 200)
      return { status: 'authorized', tokens: this.tokens(body) };
    const error = typeof body.error === 'string' ? body.error : '';
    if (error === 'authorization_pending')
      return { status: 'pending', intervalMs };
    if (error === 'slow_down')
      return { status: 'pending', intervalMs: intervalMs + 5000 };
    if (error === 'access_denied')
      throw new XaiAuthorizationError('xAI sign-in was declined.');
    if (error === 'expired_token')
      throw new XaiAuthorizationError('The sign-in code expired. Start again.');
    throw new XaiAuthorizationError(
      'xAI sign-in could not finish. Please retry.',
    );
  }
  async refresh(tokens: XaiTokens): Promise<XaiTokens> {
    if (!tokens.refreshToken)
      throw new XaiAuthorizationError(
        'Reconnect xAI to authorize this workspace.',
      );
    const { status, body } = await this.post(TOKEN_URL, {
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
      client_id: XAI_OAUTH_CLIENT_ID,
    });
    if (status !== 200)
      throw new XaiAuthorizationError(
        'Your xAI connection expired. Reconnect xAI and try again.',
      );
    // xAI rotates refresh tokens; tokens() keeps the newest, falling back to
    // the previous one only when the response omits a replacement.
    return this.tokens(body, tokens.refreshToken);
  }
  /** The access token to send to https://api.x.ai/v1, or undefined when due. */
  accessToken(tokens: XaiTokens): string | undefined {
    return tokens.expiresAt - this.now() > EXPIRY_SKEW_MS
      ? tokens.accessToken
      : undefined;
  }
}
