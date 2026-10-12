# Solana workspace

Open **Pump.fun**, **Jupiter**, or **Wallets & assets** in the sidebar. They open the same side drawer, modeled on `/Applications/Clawd Bot.app`'s Solana workspace: market and wallet tabs, searchable launch cards, a GitHub filter, feed pause/resume, mint copying, and Pump.fun/explorer links. The drawer fits desktop and mobile and remains available when the chat model is not configured.

The live launch source is `wss://clawd-ws.fly.dev/ws`. The client validates frames, retains the latest 120 unique mints per open session, reconnects with backoff, reports stale data after 45 seconds, and closes the socket when paused, switched to the wallet tab, or unmounted. Relay data is discovery information; transaction preparation reads current mainnet state separately.

**Launch or trade** opens the existing official Pump SDK transaction panel. It uses a private, account-scoped conversation context without requiring a model. Connect a Wallet Standard wallet to build unsigned launch/buy/sell transactions and review their inputs, fees, slippage, payer, instructions and expiry before approving in the wallet. A separately selected encrypted local Dot wallet retains the existing local approval flow. Switching a trading wallet does not switch the registered account. A submitted signature is distinct from confirmed settlement.

The connected-wallet and registration flows never request a private key or recovery phrase. Hosted OWS signing remains disabled. Each browser wallet transaction requires explicit review, a matching signed message and signatures, unexpired blockhash, and single-use submission. Pump builders use the official `@pump-fun/pump-sdk` and `@pump-fun/pump-swap-sdk` packages; see [Pump.fun implementation](PUMP-FUN.md).

## DFlow quote cards

The drawer's quote form and the `dflow_quote` Dot tool read the official DFlow `/order` endpoint with synchronous routing. The card shows input, expected/minimum output, slippage, the verified SOL platform fee, and quote expiry. Editing any input clears the old quote. Provider outages and fee-limit errors are explicit.

`POST /api/markets/dflow/quote` requires a registered account or the existing owner authorization. Provider credentials stay on the server; the model/card receives a strict quote whitelist without wallet details or transaction bytes. DFlow cards are indicative comparisons. Pump.fun and Jupiter build separate transactions with their own reviews and fees. Prediction market transactions are not offered by this spot quote panel.

Server configuration uses `DFLOW_API_KEY`, `DFLOW_QUOTE_API_URL=https://quote-api.dflow.net`, `DFLOW_TIMEOUT_MS`, and `DFLOW_PUBLIC_SPOT_FEE_SOL`, `DFLOW_PUBLIC_SPOT_SOL_FEE_ACCOUNT`, `DFLOW_PUBLIC_SPOT_FEE_OWNER`, `DFLOW_PUBLIC_SPOT_MAX_FEE_BPS`, `DFLOW_PUBLIC_SPOT_MAX_FEE_OVERAGE_BPS`. Token decimals are read from the actual SPL or Token-2022 mint using server-only `SOLANA_RPC_URL` with the public mainnet endpoint as fallback.

## Jupiter swaps and inline cards

Open the **Jupiter** tab to quote any supported token pair. The default managed order uses Jupiter's routing and landing flow. Advanced build mode exposes fast routing, automatic RTSE or fixed slippage, and a maximum account count. Fast mode is a beta latency option that can change pricing and priority-fee estimation; lowering the account count can reduce route quality. These choices and the resulting minimum output appear before approval.

Connect a browser wallet, then prepare a swap for review. The review shows the exact transaction, route, fees, signer addresses, simulation, version and expiry. Changing an input or wallet invalidates the old review. Jupiter uses v0 transactions for compatibility with the installed wallet stack. The managed order is submitted to Jupiter only after a matching wallet signature; custom builds use the mainnet RPC path. Submission and confirmed settlement are separate states.

Chat automatically renders successful `jupiter_quote` results as inline cards. Its connected-wallet context includes only the public trading address, never wallet secrets or authorization. Prepared chat transactions use the same explicit review and wallet approval. Quotes work without a model or conversation; preparing creates an account-private context when needed.

`JUPITER_API_KEY` stays on the server and is sent to the fixed official Swap API V2 origin. See [Jupiter integration](jupiter.md), [official documentation index](https://developers.jup.ag/docs/llms.txt), [Order & Execute](https://developers.jup.ag/docs/swap/order-and-execute), and [Build](https://developers.jup.ag/docs/swap/build).

Official references: [DFlow order API](https://pond.dflow.net/build/trading-api/order/order), [DFlow platform fees](https://pond.dflow.net/build/recipes/trading/platform-fees), and [Pump public docs](https://github.com/pump-fun/pump-public-docs).

See [registration](AUTHENTICATION.md) for fresh-account and session verification and the release artifacts for actual production evidence. No funded trade is implied by the browser registration checks or mocked transaction UI tests.
