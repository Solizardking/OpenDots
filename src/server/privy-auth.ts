import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface PrivyAuthConfig {
  appId: string;
  appSecret: string;
  clientId?: string;
}
export interface PrivyIdentity {
  subject: string;
  displayName?: string;
}
export class PrivyAuth {
  private jwks: JWTVerifyGetKey;
  constructor(
    readonly config: PrivyAuthConfig,
    private request: typeof fetch = fetch,
    keySet?: JWTVerifyGetKey,
  ) {
    this.jwks =
      keySet ??
      createRemoteJWKSet(
        new URL(`https://auth.privy.io/api/v1/apps/${config.appId}/jwks.json`),
      );
  }
  async verifyAccessToken(accessToken: string) {
    const { payload } = await jwtVerify(accessToken, this.jwks, {
      issuer: 'privy.io',
      audience: this.config.appId,
      algorithms: ['ES256'],
      requiredClaims: ['sub', 'sid', 'iat', 'exp'],
    });
    if (
      typeof payload.sub !== 'string' ||
      !payload.sub.startsWith('did:privy:')
    )
      throw new Error('Invalid Privy identity.');
    return payload.sub;
  }
  async verifyIdentity(
    accessToken: string,
    address?: string,
  ): Promise<PrivyIdentity> {
    const subject = await this.verifyAccessToken(accessToken);
    const response = await this.request(
      `https://auth.privy.io/api/v1/users/${encodeURIComponent(subject)}`,
      {
        headers: {
          'privy-app-id': this.config.appId,
          Authorization: `Basic ${Buffer.from(`${this.config.appId}:${this.config.appSecret}`).toString('base64')}`,
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error('Privy could not verify this user.');
    const user = (await response.json()) as {
      id?: string;
      linked_accounts?: {
        type?: string;
        chain_type?: string;
        address?: string;
        name?: string;
        username?: string;
      }[];
    };
    if (
      user.id !== subject ||
      (address !== undefined &&
        !user.linked_accounts?.some(
          (account) =>
            account.type === 'wallet' &&
            account.chain_type === 'solana' &&
            account.address === address,
        ))
    )
      throw new Error(
        'This Solana wallet is not linked to the authenticated Privy user.',
      );
    const social = user.linked_accounts?.find((account) =>
      ['google_oauth', 'twitter_oauth', 'github_oauth'].includes(
        account.type || '',
      ),
    );
    return {
      subject,
      displayName: (social?.name || social?.username)?.slice(0, 100),
    };
  }
  async verify(accessToken: string, address: string) {
    return (await this.verifyIdentity(accessToken, address)).subject;
  }
}
