# Persistent trading intelligence

The trading brain belongs to OpenDots. Open **Solana workspace → Trading brain**
for the selected Dot, or ask the Dot to save a trading strategy, recall its
journal, compare sources, or evaluate the saved setup. Chat exposes
`save_trading_strategy`, `trading_brain`, `trading_journal`, and
`monitor_trading_strategy`; all use the current authenticated owner and Dot.

Set `SUPERMEMORY_API_KEY`, `TYPESAFE_API_KEY`, and optionally `JUPITER_API_KEY`
in the server environment. Local development reads the ignored `.env`.
Electron's provider setup stores these keys through its existing encrypted
Keychain configuration. Keys are never embedded in the distributed app or
returned in configuration responses. Mem0 conversation memory remains separate.

The workspace SQLite database persists strategy versions, decisions, observed
paper outcomes, monitor expiry, and a retryable Supermemory outbox in
`trading_strategies` and `trading_journal`. Both owner and Dot scope every record.
Supermemory namespaces hash the owner/Dot identity as
`opendots_trading_<sha256(scope)>`. Hybrid v5 search includes related documents;
the graph shows strategy, token, decision, outcome, and recalled memory links.
Queued documents become indexed only after Supermemory reports completion.

The server connects to both requested sources:

- https://pump-stream-production.up.railway.app/ using its session/CSRF ticket
  handshake for WebSocket access.
- https://clawd-ws.fly.dev/ using its public `/ws` subscription.

Source health, connection state and freshness are independent. Replayed,
malformed, oversized or old announcements are excluded. Pump stream may report
degraded health even while supplying events. Announcements are evidence of an
observation, not a price, verified token identity, trade fill or profit.
DEX Screener supplies actual Pump.fun/PumpSwap pool prices and liquidity;
optional Jupiter Tokens V2 supplies exact-mint token metadata. Providers remain
explicitly unavailable when a request fails.

TypeSafe evaluates `jev-latest` using batched Choice (action/routing), Score
(risk/entity similarity), and Noul (strategy/evidence/identity) questions.
Responses are validated against the closed sets and probability distributions.
Natural-language function routing supports evaluation, memory recall, source
comparison and outcome explanation. Similar token names never merge distinct
mint addresses. Execution commands remain unsupported.

Monitoring is opt-in, once per minute for one hour, with a ceiling of 60
successful decisions per Dot per day and 10 evaluations per workspace per
minute. It continues while the server runs after the panel closes, persists
across restarts, and stops when the workspace pauses or Dot/global memory or
research permission is disabled. Private provider requests are cancelled when
permissions change.

Eligible buy/sell decisions require fresh priced pool evidence, the saved
liquidity minimum, sufficient action/risk confidence and affirmative strategy
and evidence probabilities. The review route checks the same strategy version,
45-second freshness, owned conversation and saved SOL cap, then prepares through
the existing Pump service. The existing approval card controls signing and
submission; the brain never automatically trades. Jupiter uses the existing
wallet approval path separately.

After five minutes (or thirty when explicitly requested), an eligible decision
can receive a later real price observation from the same pool. These paper
benchmarks exclude fees, slippage and execution. Three or more current-strategy
outcomes can raise the confidence threshold in proportion to observed losses,
up to 0.99; they never lower it. This is policy adaptation, not model training or
realized profit. An absence of eligible observations yields zero outcomes.

Private API routes are mounted behind the existing workspace authentication and
origin checks:

- `GET /api/markets/brain/config` and `/feeds`
- `GET /api/dots/:dotId/trading`
- `PUT /api/dots/:dotId/trading/strategy`
- `POST /api/dots/:dotId/trading/monitor`, `/decide`, and `/review`

Run `npm test`, `npm run typecheck`, and `npm run build`. The build copies the
five native ESM provider/store/feed adapters into the compiled server; the
Electron build bundles the same adapters. This implementation does not deploy
or replace an existing signed Mac application.
