# ChatGPTEE Agent

Install with `npm install -g https://chatgptee.ai/agent/chatgptee-agent-0.1.1.tgz`.
Run `chatgptee-agent login`, then approve the displayed code at https://chatgptee.ai/authorize.

The CLI uses the existing ChatGPTee Privy app. It stores access and rotating refresh tokens in the OS credential manager and keeps ephemeral HPKE-decrypted signing keys in memory. A credential manager must be available; there is no plaintext token fallback. Linux requires a working Secret Service keyring.

`list-wallets` shows wallets available to the grant. `rpc --wallet ID` accepts a Privy wallet RPC JSON body on stdin. `fetch URL --wallet ID --max-usdc 0.1` makes an x402 request using USDC on Base or Solana, with an explicit amount ceiling (at most 1 USDC). Wallet policies still apply. The CLI's payment ceiling does not impose a general limit on an entire device authorization.

`logout` removes local credentials. Revoke authorization on `/authorize` to stop token refresh for the grant. Access tokens already issued can remain valid until expiry, up to 15 minutes.

Never pass an app secret or `PRIVY_SIGNING_KEY` to an end-user CLI. Device authorization does not require either. No wallet is funded and no payment is made during installation or login.
