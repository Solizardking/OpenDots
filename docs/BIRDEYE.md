# Birdeye in chat

Open a conversation and choose **Research** in the chat header. The Birdeye panel and the Dot's research tools use the same backend. A public token mint or wallet address is enough; connecting a signing wallet is optional for research.

Set `BIRDEYE_API_KEY` in the server environment or the local `.env`. Docker Compose forwards it. In the Mac app, save the Birdeye connection under **Settings → Provider connections**; it uses the existing encrypted credential store. Restart the server after environment changes. No `VITE_` credential is needed. The browser, paired phone and automation service never receive this key.

| Research            | Data and behavior                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Portfolio           | Three wallet reads load holdings, net worth history and PnL together. Holdings use scaled amounts, money fields become numbers, and missing prices remain unknown. |
| Wallet comparison   | Compare up to 50 public wallets on one token, ranked by total PnL.                                                                                                 |
| Token investigation | Market, chart, ownership, behavior, traders, fees, authority and supply events, with individual unavailable panels.                                                |
| Rug / wash checks   | Evidence and heuristic flags, including missing signals. They do not certify safety or sellability.                                                                |
| Cross-DEX prices    | Pools ranked by liquidity, USD conversion by base/quote orientation, consolidated reference and closed-candle confirmation.                                        |
| Liquidity           | The deepest pool's liquidity and balances aligned with token price; security/supply enrichment on flagged drops.                                                   |
| Charts              | OHLCV, history and price stats, interval selection and older-history loading.                                                                                      |
| Discovery           | Trending, server-filtered screening and security-gated new listings.                                                                                               |
| Watchlist / whales  | Batched prices with explicit unknown entries, large trades and buy/sell context.                                                                                   |
| Smart money         | Net-flow candidates plus an individual wallet's all-time cumulative record and recent trades.                                                                      |
| Alerts              | Persistent conversation-scoped absolute/percent/custom-baseline thresholds, closed-candle confirmation, stale-price guards and crossing debounce.                  |
| Live feed           | Authenticated SSE relay for the server-owned Birdeye socket. Subscription availability depends on the account's plan.                                              |
| Credits             | Cached credit usage and visible quota/tier errors.                                                                                                                 |

Use **Ask Dot** to place a research question in the composer, then send it when ready. **Open in ChatGPT** shares a public-token question only; it does not export wallet holdings, private chat or credentials.

All `/api/birdeye/*` routes inherit the application's owner/session and same-origin checks, require an owned conversation and enforce current workspace/Dot research permission. Pausing the workspace disconnects its live subscribers and suspends alert checks. The paired-phone boundary allows status/query/stream reads; persistent alert changes stay in the desktop workspace. Alert state lives in each workspace's SQLite database, while provider caches/rate budgets and the upstream socket are shared across hosted user runtimes. There are no Birdeye signing or execution endpoints.

The query API is `POST /api/birdeye/query` with `{ "threadId": "<conversation>", "workflow": "investigation", "address": "<Solana mint>" }`. `GET /api/birdeye/status?threadId=<conversation>` checks configuration without spending credits. Alerts use `/api/birdeye/alerts` and `/api/birdeye/alerts/poll`. `POST /api/birdeye/stream` returns SSE; the browser uses authenticated fetch rather than sending credentials in an EventSource URL.

The shared schema bounds inputs and fixes the chain to Solana. Search exposes canonical candidates instead of choosing a ticker silently. REST calls use a fixed Birdeye origin, server-only `X-API-KEY` and `x-chain: solana`. Wallet budgets are separate from chart/discovery reads. Failures expose sanitized account/plan/quota states, and missing data never becomes zero-priced market evidence. Quota and authentication failures pause account requests; an unavailable paid endpoint backs off independently. No fallback provider silently replaces Birdeye.

Responses preserve the oldest provider fetch used as `observedAt`/`fetchedAt`, include the current `requestedAt` and `cacheAgeMs`, and retain the token's own update timestamp. A cached response does not acquire a new market observation time. Authority fields explicitly returned as null display **Renounced**, while absent controls remain unknown. Ratio fields and percentage fields use their documented units.

The default screener uses standard offset pagination, available below the Business scroll tier. Optional features must return their actual entitlement failure rather than a fabricated result. Birdeye's data APIs supply research signals; any trade remains in the existing Pump/Jupiter review and signing flow.

Implementation: shared contracts in `src/shared/birdeye-types.ts`; provider in `src/server/birdeye-service.ts`; scoped routes/tools in `birdeye-routes.ts` and `birdeye-tools.ts`; persisted monitoring in `birdeye-monitor.ts`; account socket in `birdeye-stream.ts`; chat panel/cards in `src/client`. `src/build/public-docs.ts` includes the routes in the generated product documentation. `src/browser` remains the isolated browser automation service and consumes the chat UI without possessing market credentials.

Verification:

```sh
npm run typecheck
npm test -- tests/birdeye.test.ts tests/birdeye-access.test.ts tests/birdeye-monitor.test.ts tests/birdeye-stream.test.ts tests/birdeye-ui.test.tsx
npm run build
npm run verify:birdeye-ui
npm run verify:birdeye-provider
npm run verify:birdeye-stream
```

The UI verifier uses isolated provider/session fixtures. The provider verifier uses the configured key for one batched wrapped-SOL quote; without a key it reports missing configuration and exits with code 2. The stream verifier opens one wrapped-SOL subscription for at most 12 seconds, records sanitized connection states, and closes it. A successful quote does not establish access to wallet, holder-profile or WebSocket features; their entitlement states remain visible independently.

October 13, 2026 verification: live REST reads returned portfolio/PnL for a public trader, token investigation, charts, cross-DEX pool prices, search, smart money, trending, screening and gated listings. USDC's Meteora pool returned aligned liquidity/price history. SOL's deepest staking pool returned no liquidity history and remains a partial result. Birdeye accepted the socket connection but rejected its subscription for key/origin access, so live streaming is shown as unavailable; no price event was claimed. The authenticated relay, reconnect handling and disconnect cleanup also have isolated fixture tests. Evidence is under `artifacts/birdeye-fixtures/`.

Reference: the supplied Birdeye use-case material and [Birdeye API documentation](https://data.birdeye.so/docs/use-cases/overview).
