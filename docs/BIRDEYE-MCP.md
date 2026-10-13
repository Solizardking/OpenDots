# Official Birdeye MCP and meme-token details

Solana Dots adds the official Beta MCP at `https://mcp.birdeye.so/mcp` and the exact Data API meme-detail dataset to its existing [Birdeye research workspace](BIRDEYE.md). These tools read data; wallet review and approval continue to control trades.

## Setup

Add the credential to the ignored server `.env` and restart:

```dotenv
BIRDEYE_API_KEY=REPLACE_ON_THE_SERVER
```

Docker Compose forwards the key to the app container. In the native Mac app, use **Settings → Provider connections → Birdeye**, then **Save provider connections**. The app saves the credential with Keychain-backed encryption and restarts the local server. The key is not returned to the browser or phone, included in the app download, or sent in model prompts.

Hosted users share the server's configured Birdeye account and credit allowance. Their conversations and wallet research stay scoped to their signed-in workspace. Enable research in both workspace and Dot settings. A configured key establishes configuration; a successful provider response establishes access to that particular dataset.

## Use from Dot chat

Permitted Dots receive three additional read-only tools:

| Tool                  | Purpose                                                                                |
| --------------------- | -------------------------------------------------------------------------------------- |
| `birdeye_mcp_catalog` | Discover current official MCP tools and input schemas; optionally filter with `search` |
| `birdeye_mcp_call`    | Call a discovered tool using its exact `name` and `arguments`                          |
| `birdeye_meme_detail` | Read an exact public Solana mint's meme-detail dataset using `address`                 |

The MCP call tool accepts only tools explicitly annotated as read-only by the discovered server catalog. Unannotated or mutating tools are not eligible. The API key stays in the server request header, outside the tool arguments and model context.

For the requested token, ask: “Use Birdeye to read meme details for `HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump`, and show the source, observation time and any unavailable fields.” For other MCP datasets, ask the Dot to discover the relevant tool first. Existing Birdeye workflows and opt-in alert controls remain separate from these additional MCP and meme-detail reads.

The authenticated application routes use the same conversation research scope as the existing Birdeye workspace:

| Application route              | Input                                                             |
| ------------------------------ | ----------------------------------------------------------------- |
| `GET /api/birdeye/mcp/catalog` | Query: `threadId`; optional `search`                              |
| `POST /api/birdeye/mcp/call`   | JSON: `threadId`, exact discovered `name`, and `arguments` object |
| `GET /api/birdeye/meme-detail` | Query: `threadId` and exact mint `address`                        |

`threadId` must identify a conversation in the authenticated workspace whose Dot and workspace permit research. Pausing or revoking research prevents these reads. A native owner token or hosted session supplies application authentication; the Birdeye key is never a browser request parameter.

## Official Beta MCP authentication

The authenticated server uses an `x-api-key` request header. Birdeye also offers a public keyless endpoint at the same URL. Authenticated tool access and limits depend on the account's plan. Tool names, schemas and limits can change during Beta: discover the current input schema before calling a tool rather than guessing its name from a REST path.

OpenDots connects from the server using its existing MCP SDK. For another MCP-compatible client, the supplied Birdeye setup uses this adapter configuration:

```json
{
  "mcpServers": {
    "birdeye-api-mcp": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote@0.1.38",
        "https://mcp.birdeye.so/mcp",
        "--header",
        "x-api-key:${API_KEY}"
      ],
      "env": {
        "API_KEY": "<YOUR_API_KEY>"
      }
    }
  }
}
```

Store a real credential only in that client's protected local configuration or supported secret store. OpenDots' general **Connections** bearer-token form uses a different authentication scheme; the built-in Birdeye integration supplies the correct API-key header.

References: [Birdeye MCP setup](https://data.birdeye.so/docs/agents/birdeye-mcp), [official tool catalog](https://data.birdeye.so/docs/agents/tool-catalog), [Data API reference](https://docs.birdeye.so/reference). Birdeye's Beta feedback address is `bds.support@birdeye.so`.

## Task-specific endpoint catalog

REST reads use the fixed Birdeye origin `https://public-api.birdeye.so`, server-only `X-API-KEY` authentication and `x-chain: solana`. This map follows the supplied Birdeye catalog and task guides. Dataset entitlements and the discovered MCP catalog determine availability.

| Research question                             | Data API endpoint                       |
| --------------------------------------------- | --------------------------------------- |
| Supported networks                            | `GET /defi/networks`                    |
| Current consolidated token price              | `GET /defi/price`                       |
| Historical price points                       | `GET /defi/history_price`               |
| Token OHLCV candles                           | `GET /defi/v3/ohlcv`                    |
| Token overview and selected timeframe metrics | `GET /defi/token_overview`              |
| Latest token trades                           | `GET /defi/v3/token/txs`                |
| Trending tokens                               | `GET /defi/token_trending`              |
| Filtered token discovery                      | `GET /defi/v3/token/list`               |
| Bulk discovery scroll session                 | `GET /defi/v3/token/list/scroll`        |
| New token listings                            | `GET /defi/v2/tokens/new_listing`       |
| Meme token list                               | `GET /defi/v3/token/meme/list`          |
| One meme token's details                      | `GET /defi/v3/token/meme/detail/single` |
| Token security evidence                       | `GET /defi/token_security`              |
| Creation and authority context                | `GET /defi/token_creation_info`         |
| Holder concentration                          | `GET /holder/v1/distribution`           |
| Transfer history                              | `POST /token/v1/transfer`               |
| Watchlist prices in a batch                   | `GET` or `POST /defi/multi_price`       |
| Trade-volume baseline                         | `GET /defi/v3/token/trade-data/single`  |
| Large trades and buy/sell pressure            | `GET /defi/v3/token/txs-by-volume`      |
| Smart-money token flows                       | `GET /smart-money/v1/token/list`        |
| Top traders for a token                       | `GET /defi/v2/tokens/top_traders`       |
| Wallet's cumulative PnL details               | `POST /wallet/v2/pnl/details`           |
| Wallet's recent swaps                         | `GET /trader/txs/seek_by_time`          |
| Current wallet net worth                      | `GET /wallet/v2/current-net-worth`      |
| Wallet net worth history                      | `GET /wallet/v2/net-worth`              |
| Wallet PnL summary                            | `GET /wallet/v2/pnl/summary`            |
| Wallet transaction history                    | `GET /v1/wallet/tx_list`                |
| Token or market search                        | `GET /defi/v3/search`                   |
| Price change by timeframe                     | `GET /defi/v3/price/stats/single`       |
| Token pools ranked by liquidity               | `GET /defi/v2/markets`                  |
| Pool-specific overview                        | `GET /defi/v3/pair/overview/single`     |
| Pool OHLCV candles                            | `GET /defi/v3/ohlcv/pair`               |
| Account credit usage                          | `GET /utils/v1/credits`                 |

## Composing the supplied research pipelines

Discovery starts with trending or server-side list filters. Request a full `token_overview` only for a selected candidate, with the frames the question needs. Batch watchlist prices in groups of at most 100 and preserve unknown results as `null`. Trending has a maximum page size of 50; regular filtered lists use offset/limit pagination with at most 100 per request. The higher-tier scroll API has account-level session constraints and needs a coordinated worker; a successful one-time list read does not establish a deployed bulk scanner.

New-listing research uses creation, security, overview and holder evidence before treating a candidate as eligible for trade review. Holder distribution uses `token_address`; most token overview and security endpoints use `address`. Solana liquidity comes from token overview, and an unavailable signal remains unknown. A newly observed listing or pool does not establish token safety.

Whale research first reads a token's USD volume baseline, then queries large trades with explicit `volume_type=usd` and `token_address`. Sum `volume_usd` separately for buys and sells relative to the tracked mint. For successive reads, use `after_time` and deduplicate by transaction hash plus instruction and inner-instruction indexes so distinct trade legs survive.

Smart-money research starts with token net flows, then token top traders, and then the selected wallet's history. Top traders require `address`, `time_frame`, `sort_by` and `sort_type`. Use `duration=all` and `position_scope=cumulative` for an all-time PnL check. Its win rate is a ratio; current token prices may be `null`. Trader tags are caution signals. A wallet's past returns do not approve copying its next trade.

Price-threshold research uses batch `value` prices and `updateUnixTime` freshness, then the required timeframe's `price_change_percent` from price stats. Confirm evidence on a completed OHLCV interval: the last returned candle may still be forming. A lasting monitor additionally needs saved crossing state and an explicitly enabled polling schedule; an on-demand research result does not establish alert delivery.

Cross-DEX research resolves the deepest pools, prices the tracked token in USD, compares each pool against the consolidated token price, and checks several closed pool candles with meaningful volume. A pair overview's `price` is base in quote units. Convert with the quote token's USD price, or invert for a tracked quote-side token. Markets' item `address` identifies the pool, and a missing market price is not zero. A spread observation is not an executable arbitrage quote.

## Requested meme-token detail read

The exact requested mint is `HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump`. The matching Data API request is:

```sh
curl --request GET \
  --url 'https://public-api.birdeye.so/defi/v3/token/meme/detail/single?address=HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump' \
  --header 'X-API-KEY: <api-key>' \
  --header 'x-chain: solana'
```

This is a placeholder-only reference request. Use the application's server-side integration for the real key rather than placing it in shell history or command-line arguments. Preserve the mint exactly when requesting the dataset; the `pump` suffix does not authorize a purchase.

## Credits, errors and verification

Retain the source and observation time of each dataset result. Treat stale responses, unavailable tools, plan denials, exhausted allowance and rate-limit refusals as explicit missing evidence. The supplied catalog does not establish per-call MCP compute-unit charges; confirm current [compute-unit costs](https://data.birdeye.so/docs/resources/compute-unit-cost) and [plan pricing](https://birdeye.so/data-api/pricing) before sustained workloads. A shared server credential means shared cost and rate limits across users.

A successful MCP initialization alone does not prove completed session verification, tool listing or execution. A provider session-store error remains a provider error even if initialization returned HTTP 200. Direct Data API reads establish their own evidence independently.

Local fixtures validate routing, permissions and response handling. Live MCP discovery, a successful tool call, a successful REST meme-detail response, and an actual model reply using the tool are separate pieces of evidence. Wallet signing and any resulting chain receipt remain in the existing explicit transaction-review flow.
