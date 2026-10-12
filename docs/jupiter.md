# Jupiter swaps

The Solana workspace and inline chat tools use the current [Jupiter Swap API](https://developers.jup.ag/docs/swap). The server reads `JUPITER_API_KEY` and a configured HTTPS Solana mainnet RPC; credentials remain server-side. Provider calls use the fixed `https://api.jup.ag/swap/v2` host, a 15-second timeout and bounded JSON responses.

Managed **Order** quotes aggregate Jupiter’s routers and default to automatic slippage. The quote card is read-only and contains no transaction bytes or provider execution credentials. Preparing requests a new wallet-specific order; the user reviews its exact amounts, actual slippage, routing and fees, fee payer, existing signatures, required deferred signers, balance and simulation before signing in their connected wallet. JupiterZ and sponsored orders can require Jupiter to add maker or payer signatures through `/execute`. Total `feeBps` can include gasless recoup; the platform fee is reported separately. The app adds no referral or transfer fee.

Advanced **Build** uses Metis instructions, optional fast mode, automatic RTSE or fixed slippage, and a maximum account count from 1 to 64. The server checks lookup-table mappings against mainnet, estimates compute at 1.4 million units, rebuilds with a 20% buffer, and simulates the exact final message. Compute prices are clamped at **10,000,000 micro-lamports per compute unit** and both the applied price and ceiling appear in review. Unexpected tips are rejected because this integration submits builds through its configured RPC and requests no tip. All included instructions and account permissions are available in the review.

Both paths explicitly request **Solana version 0**. Version 1 is unsupported by this integration’s current web3.js and wallet signing path; Jupiter’s [version guide](https://developers.jup.ag/docs/swap/advanced/transaction-versions) requires a compatible wallet and `@solana/kit` v8 or later. Build uses `transactionVersion=0`; Order uses `maxSupportedTransactionVersion=0`.

Approvals are private to their conversation owner, immutable and single-use. Changing a draft or wallet requires a fresh preparation. The server verifies the exact reviewed message, the connected wallet’s signature and existing provider signatures; missing signatures are permitted only for explicitly declared JupiterZ makers or gasless provider payers. It rechecks mainnet, expiry and blockhash before claiming submission. A managed execute call is never repeated after a transport failure or ambiguous receipt. An unsigned sponsored payer cannot be used to derive a transaction ID.

`submitted` means a submission receipt, including an uncertain submission. Only an independent confirmed or finalized on-chain result becomes `confirmed`; deferred-payer receipts must also resolve to the exact approved message and valid complete signatures. Quote-only responses, unsigned prepared transactions and provider `Success` responses are not proof of an executed swap. Tests use generated fixture wallets and mocked provider/RPC responses; they do not fund wallets, execute swaps or register RFQ makers/AMMs.

Endpoints within the authenticated workspace API:

- `GET /markets/jupiter/status`
- `POST /markets/jupiter/context` with `{dotId}`; no model configuration is required.
- `POST /markets/jupiter/quote` with `{input,address?}`; an advanced Build quote requires a public address.
- `POST /conversations/:threadId/jupiter/prepare` with `{input,address}`.
- `GET /conversations/:threadId/jupiter/requests` and `/requests/:id`.
- `POST /conversations/:threadId/jupiter/requests/:id/decline`.
- `POST /conversations/:threadId/jupiter/requests/:id/submit` with `{confirm:true,transactionHash,signedTransactionBase64}`.

The `jupiter_quote` tool automatically renders a quote card. `prepare_jupiter_swap` returns a private review request only when the interactive `review_jupiter_transaction` approval surface is available. Signing remains in the browser wallet and is never a model tool.
