import {
  auth,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ConnectionStore } from './connection-store.js';
import { createPublicMcpFetch } from './public-mcp-transport.js';

export const SUPERMEMORY_MCP_URL = 'https://mcp.supermemory.ai/mcp';
export const SUPERMEMORY_OAUTH_ISSUER = 'https://api.supermemory.ai/api/auth';
const RESOURCE_METADATA =
  'https://mcp.supermemory.ai/.well-known/oauth-protected-resource/mcp';
export const SUPERMEMORY_OAUTH_TTL_MS = 10 * 60_000;
const MAX_AUTH_BYTES = 512_000;

export interface SupermemoryOAuthCredentials {
  redirectUrl: string;
  clientInformation?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  codeVerifier?: string;
  discovery?: OAuthDiscoveryState;
}
export type SupermemoryOAuthNetwork = (signal: AbortSignal) => {
  fetch: typeof fetch;
  close(): Promise<void>;
};

export function isSupermemoryMcpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return (
      url.origin === 'https://mcp.supermemory.ai' &&
      url.pathname.replace(/\/$/, '') === '/mcp' &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

// The SDK uses this fetch for discovery, dynamic registration and tokens as
// well as MCP calls. Trust only the fixed provider origins; preserve pinning.
export function supermemoryFetch(networkFetch: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (
      !['https://mcp.supermemory.ai', 'https://api.supermemory.ai'].includes(
        url.origin,
      ) ||
      url.username ||
      url.password
    )
      throw new Error('Supermemory OAuth destination is not allowed.');
    const response = await networkFetch(request);
    if (url.href === SUPERMEMORY_MCP_URL) return response;
    const reader = response.body?.getReader();
    if (!reader) return response;
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_AUTH_BYTES)
          throw new Error('Supermemory OAuth response is too large.');
        chunks.push(chunk.value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
}

export function supermemoryCallback(origin: string): string {
  const url = new URL(origin);
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      ))
  )
    throw new Error('Use the application origin to connect Supermemory.');
  return new URL('/supermemory/callback', origin).href;
}

export class SupermemoryAuthorizationRequired extends Error {
  constructor() {
    super('Reconnect Supermemory to authorize this workspace.');
  }
}

export class SupermemoryOAuth {
  constructor(
    readonly store: ConnectionStore,
    private network: SupermemoryOAuthNetwork = createPublicMcpFetch,
  ) {}
  private require(id: string) {
    const connection = this.store.get(id);
    if (
      !connection ||
      !isSupermemoryMcpUrl(connection.url) ||
      connection.provider !== 'supermemory'
    )
      throw new Error('Supermemory connection not found.');
    return connection;
  }
  private update(
    id: string,
    patch: Partial<SupermemoryOAuthCredentials>,
    status?: 'pending' | 'connected' | 'expired',
  ) {
    this.require(id);
    const current = this.store.oauthCredentials(id);
    if (!current) throw new SupermemoryAuthorizationRequired();
    this.store.saveOAuth(id, { ...current, ...patch }, status);
  }
  provider(
    id: string,
    interactive?: { state: string; redirect: (url: string) => void },
  ): OAuthClientProvider {
    this.require(id);
    const credentials = () => {
      this.require(id);
      const value = this.store.oauthCredentials(id);
      if (!value) throw new SupermemoryAuthorizationRequired();
      return value;
    };
    return {
      get redirectUrl() {
        return credentials().redirectUrl;
      },
      get clientMetadata(): OAuthClientMetadata {
        return {
          client_name: 'ChatGPTEE Supermemory',
          client_uri: new URL(credentials().redirectUrl).origin,
          redirect_uris: [credentials().redirectUrl],
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          scope: 'openid profile email offline_access',
        };
      },
      state: () => {
        if (!interactive) throw new SupermemoryAuthorizationRequired();
        return interactive.state;
      },
      clientInformation: () => credentials().clientInformation,
      saveClientInformation: (value) => {
        if (value.issuer !== SUPERMEMORY_OAUTH_ISSUER)
          throw new Error('Supermemory OAuth issuer is not allowed.');
        this.update(id, { clientInformation: value });
      },
      tokens: () => credentials().tokens,
      saveTokens: (value) => {
        if (
          value.issuer !== SUPERMEMORY_OAUTH_ISSUER ||
          value.token_type.toLowerCase() !== 'bearer'
        )
          throw new Error('Supermemory OAuth token issuer is not allowed.');
        this.update(
          id,
          {
            tokens: {
              ...value,
              refresh_token:
                value.refresh_token ?? credentials().tokens?.refresh_token,
            },
            codeVerifier: undefined,
          },
          'connected',
        );
      },
      saveCodeVerifier: (value) => {
        if (!interactive) throw new SupermemoryAuthorizationRequired();
        this.update(id, { codeVerifier: value });
      },
      codeVerifier: () => {
        const value = credentials().codeVerifier;
        if (!value) throw new SupermemoryAuthorizationRequired();
        return value;
      },
      redirectToAuthorization: (url) => {
        if (!interactive) throw new SupermemoryAuthorizationRequired();
        if (
          url.origin !== 'https://api.supermemory.ai' ||
          url.pathname !== '/api/auth/oauth2/authorize' ||
          url.searchParams.get('redirect_uri') !== credentials().redirectUrl ||
          url.searchParams.get('state') !== interactive.state
        )
          throw new Error('Supermemory authorization URL is not allowed.');
        interactive.redirect(url.href);
      },
      discoveryState: () => credentials().discovery,
      saveDiscoveryState: (value) => {
        const metadata = value.authorizationServerMetadata;
        if (
          value.authorizationServerUrl !== SUPERMEMORY_OAUTH_ISSUER ||
          metadata?.issuer !== SUPERMEMORY_OAUTH_ISSUER ||
          metadata.authorization_endpoint !==
            `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/authorize` ||
          metadata.token_endpoint !==
            `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/token` ||
          (metadata.registration_endpoint &&
            metadata.registration_endpoint !==
              `${SUPERMEMORY_OAUTH_ISSUER}/oauth2/register`) ||
          value.resourceMetadata?.resource !== SUPERMEMORY_MCP_URL
        )
          throw new Error('Supermemory OAuth metadata is not allowed.');
        this.update(id, { discovery: value });
      },
      validateResourceURL: async (serverUrl, resource) => {
        if (
          String(serverUrl) !== SUPERMEMORY_MCP_URL ||
          (resource && resource !== SUPERMEMORY_MCP_URL)
        )
          throw new Error('Supermemory OAuth resource is not allowed.');
        return new URL(SUPERMEMORY_MCP_URL);
      },
      invalidateCredentials: (scope) => {
        const current = credentials();
        this.update(
          id,
          {
            ...(scope === 'all' || scope === 'client'
              ? { clientInformation: undefined }
              : {}),
            ...(scope === 'all' || scope === 'tokens'
              ? { tokens: undefined }
              : {}),
            ...(scope === 'all' || scope === 'verifier'
              ? { codeVerifier: undefined }
              : {}),
            ...(scope === 'all' || scope === 'discovery'
              ? { discovery: undefined }
              : {}),
            redirectUrl: current.redirectUrl,
          },
          scope === 'all' || scope === 'tokens' ? 'expired' : undefined,
        );
      },
    };
  }
  async start(id: string, origin: string) {
    const connection = this.require(id);
    const redirectUrl = supermemoryCallback(origin);
    const previous = this.store.oauthCredentials(id);
    // A changed callback origin needs its own dynamic registration.
    this.store.saveOAuth(
      id,
      {
        redirectUrl,
        ...(previous?.redirectUrl === redirectUrl
          ? {
              clientInformation: previous.clientInformation,
              discovery: previous.discovery,
            }
          : {}),
      },
      'pending',
    );
    const state = this.store.beginOAuth(
      id,
      redirectUrl,
      SUPERMEMORY_OAUTH_TTL_MS,
    );
    const network = this.network(AbortSignal.timeout(30_000));
    let authorizationUrl: string | undefined;
    try {
      const result = await auth(
        this.provider(id, {
          state,
          redirect: (url) => {
            authorizationUrl = url;
          },
        }),
        {
          serverUrl: SUPERMEMORY_MCP_URL,
          resourceMetadataUrl: new URL(RESOURCE_METADATA),
          fetchFn: supermemoryFetch(network.fetch),
        },
      );
      if (result !== 'REDIRECT' || !authorizationUrl)
        throw new Error('Authorization did not start.');
      return { connection: this.store.get(connection.id)!, authorizationUrl };
    } catch {
      this.expired(id);
      throw new Error(
        'Supermemory authorization could not start. Please retry.',
      );
    } finally {
      await network.close();
    }
  }
  async finish(code: string, state: string, iss?: string, origin?: string) {
    if (iss && iss !== SUPERMEMORY_OAUTH_ISSUER)
      throw new Error('Supermemory authorization issuer is not allowed.');
    const { connection, callbackUrl } = this.store.consumeOAuth(
      state,
      origin ? supermemoryCallback(origin) : undefined,
    );
    this.require(connection.id);
    const credentials = this.store.oauthCredentials(connection.id);
    if (credentials?.redirectUrl !== callbackUrl)
      throw new Error('Supermemory authorization callback changed.');
    const network = this.network(AbortSignal.timeout(30_000));
    const transport = new StreamableHTTPClientTransport(
      new URL(SUPERMEMORY_MCP_URL),
      {
        authProvider: this.provider(connection.id),
        fetch: supermemoryFetch(network.fetch),
      },
    );
    try {
      await transport.finishAuth(code);
      return this.store.get(connection.id)!;
    } catch {
      this.expired(connection.id);
      throw new Error(
        'Supermemory authorization was not completed. Reconnect and try again.',
      );
    } finally {
      await transport.close().catch(() => {});
      await network.close();
    }
  }
  expired(id: string) {
    const credentials = this.store.oauthCredentials(id);
    if (credentials && this.store.get(id))
      this.store.saveOAuth(id, credentials, 'expired');
  }
}
