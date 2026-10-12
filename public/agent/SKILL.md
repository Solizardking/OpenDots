---
name: chatgptee-agent
description: Connect a self-hosted agent to user-authorized ChatGPTEE Privy wallets and make bounded USDC x402 requests.
---

# ChatGPTEE agent access

Install Node.js 24 or later, then:

```sh
npm install -g https://chatgptee.ai/agent/chatgptee-agent-0.1.1.tgz
chatgptee-agent login
```

Show the verification URL and code to the user. Wait for the user to approve at https://chatgptee.ai/authorize. Never approve a grant for the user yourself. Installation and login do not fund wallets or make payments.

The app ID is `cm7mmxm7a01bs3i2ltojavlnl`. `PRIVY_AUTH_URL=https://chatgptee.ai/authorize`. App secrets and server signing keys are never required on an agent machine.

```sh
chatgptee-agent list-wallets
chatgptee-agent rpc --wallet WALLET_ID < request.json
chatgptee-agent fetch https://PUBLIC_API/resource --wallet WALLET_ID --max-usdc 0.1
chatgptee-agent logout
```

`rpc` accepts the Privy OAuth wallet RPC body. Wallet operations require the owner's prior device authorization and must stay within their intent and wallet policies. An authorization is not permission to make unrelated payments. `fetch` supports x402 with USDC on Base, Base Sepolia, Solana mainnet or devnet, enforcing an explicit per-request limit no greater than 1 USDC. Use only APIs authorized by the user. Check facilitator receipts before reporting a settled payment.

Tokens are stored in the OS credential manager. On Linux, a working Secret Service keyring is required. The CLI fails if secure storage is unavailable. Decrypted signing keys remain in memory. Tokens refresh and rotate automatically. `logout` deletes local credentials; users can revoke the grant on `/authorize`. Previously issued access tokens can remain valid for up to 15 minutes.

The standalone Privy sandbox CLI uses a separate Privy app and is not this ChatGPTEE integration.
