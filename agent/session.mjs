import { Entry } from '@napi-rs/keyring';
import { CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from '@hpke/core';
import { Chacha20Poly1305 } from '@hpke/chacha20poly1305';
import { generateAuthorizationSignature } from '@privy-io/node';

const origin = 'https://auth.privy.io';
export class AgentSession {
  constructor(
    appId,
    request = fetch,
    store = new Entry('ai.chatgptee.agent', appId),
  ) {
    this.appId = appId;
    this.request = request;
    this.store = store;
    this.key = undefined;
  }
  save(tokens) {
    this.tokens = {
      ...tokens,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
    this.store.setPassword(JSON.stringify(this.tokens));
  }
  load() {
    const stored = this.store.getPassword();
    if (!stored) throw new Error('Run chatgptee-agent login first.');
    this.tokens = JSON.parse(stored);
  }
  async api(path, body, authenticated = false, extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'privy-app-id': this.appId,
      ...extra,
    };
    if (authenticated) headers.Authorization = `Bearer ${await this.token()}`;
    const r = await this.request(origin + '/api/oauth/v2' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const data = await r.json();
    if (!r.ok) {
      const error = new Error(
        data.error_description ?? data.error ?? `Privy returned ${r.status}.`,
      );
      error.code = data.error;
      throw error;
    }
    return data;
  }
  async token() {
    if (!this.tokens) this.load();
    if (this.tokens.expiresAt <= Date.now() + 30000) {
      const tokens = await this.api('/token', {
        grant_type: 'refresh_token',
        refresh_token: this.tokens.refresh_token,
      });
      this.save(tokens);
      this.key = undefined;
    }
    return this.tokens.access_token;
  }
  async authenticate() {
    await this.token();
    if (this.key && this.key.expiresAt > Date.now() + 30000) return this.key;
    const suite = new CipherSuite({
      kem: new DhkemP256HkdfSha256(),
      kdf: new HkdfSha256(),
      aead: new Chacha20Poly1305(),
    });
    const keys = await suite.kem.generateKeyPair();
    const spki = await crypto.subtle.exportKey('spki', keys.publicKey);
    const data = await this.api(
      '/wallets/authenticate',
      {
        encryption_type: 'HPKE',
        recipient_public_key: Buffer.from(spki).toString('base64'),
      },
      true,
      { 'privy-grant-type': 'device_code' },
    );
    const recipient = await suite.createRecipientContext({
      recipientKey: keys.privateKey,
      enc: Buffer.from(
        data.encrypted_authorization_key.encapsulated_key,
        'base64',
      ),
    });
    const bytes = Buffer.from(
      await recipient.open(
        Buffer.from(data.encrypted_authorization_key.ciphertext, 'base64'),
      ),
    );
    // Privy returns a base64 PKCS8 key, sometimes as a JSON envelope.
    const decoded = bytes.toString('utf8');
    let privateKey;
    try {
      const obj = JSON.parse(decoded);
      privateKey = obj.private_key ?? obj.authorization_key;
    } catch {
      privateKey =
        decoded.startsWith('wallet-auth:') || /^[A-Za-z0-9+/]+=*$/.test(decoded)
          ? decoded
          : bytes.toString('base64');
    }
    if (!privateKey)
      throw new Error('Privy returned an invalid authorization key.');
    this.key = {
      privateKey,
      expiresAt:
        typeof data.expires_at === 'number'
          ? data.expires_at < 1e12
            ? data.expires_at * 1000
            : data.expires_at
          : Date.parse(data.expires_at),
      wallets: data.wallets,
    };
    if (!Number.isFinite(this.key.expiresAt))
      throw new Error('Privy returned an invalid key expiry.');
    return this.key;
  }
  async rpc(walletId, body) {
    const key = await this.authenticate();
    if (!key.wallets.some((w) => w.id === walletId))
      throw new Error('This wallet is not available to the authorized agent.');
    const url =
      origin + '/api/oauth/v2/wallets/' + encodeURIComponent(walletId) + '/rpc';
    const signature = generateAuthorizationSignature({
      authorizationPrivateKey: key.privateKey,
      input: {
        version: 1,
        method: 'POST',
        url,
        body,
        headers: { 'privy-app-id': this.appId },
      },
    });
    return this.api(
      '/wallets/' + encodeURIComponent(walletId) + '/rpc',
      body,
      true,
      {
        'privy-grant-type': 'device_code',
        'privy-authorization-signature': signature,
      },
    );
  }
  logout() {
    this.store.deletePassword();
    this.tokens = undefined;
    this.key = undefined;
  }
}
