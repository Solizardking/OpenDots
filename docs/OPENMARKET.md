# OpenMarket

Open **OpenMarket** in the sidebar or the Solana workspace. The Crypto panel discovers the exact venue and instrument before loading candles, open interest, funding, volume profiles, TPO or options. The supplied quick examples prepare cross-exchange BTC volume, a 4K orderbook with 1,000 price levels, Hyperliquid liquidation levels and a minute TP/SL trigger heatmap. Choose **Load dataset** to fetch the result.

Orderbooks use `/block-sizes` recommendations for the selected instrument. HD uses five times the recommended price bucket; a custom bucket can override it. Two to five comma-separated exchange IDs become repeated upstream `exchange` parameters. Summed USD volume is charted separately because the aggregated response does not provide valid price OHLC. Every request is bounded to 200 candles or 20 heatmap snapshots, 1,000 levels and a 4 MB response. Returned points stay inside the requested time range. Results show the provider observation time.

The Polymarket panel includes the supplied politics/win-rate, top-ten ROI, open-position-size and high-activity leaderboard examples. Filters, sort direction, page size and bounded pagination remain editable. Trader profiles require a complete `0x` address. The other views include positions, market summaries, categories and platform distributions.

Set `OPENMARKET_API_KEY` in the ignored local `.env` and the dedicated ChatGPTEE Railway service Variables. Desktop users can save **OpenMarket** in Settings → Provider connections; Electron stores it with the existing macOS Keychain encryption. The browser never receives the key. Requests use the existing authenticated same-origin API at `/api/markets/openmarket/:route`; workspace identity, owner access and cross-origin checks remain in force. The Indicator Access membership API is a separate credential and is not configured by this integration.

Dots have the read-only `openmarket_data` tool when both the Dot and workspace permit research. Tool execution checks pause/revocation before and after the request. It uses the same validation, cache, bounded responses and global provider budget as the UI. OpenMarket analytics do not sign, execute trades or modify wallets.

Cross-exchange aggregation, Hyperliquid and Polymarket depend on Data API entitlements. A 403 is shown as a plan/permission error; quota refusals remain 429. Invalid keys are sanitized and there are no automatic retries or substituted datasets.

Run `npm run verify:openmarket` for adapter/access/tool tests and isolated desktop/mobile UI checks. Run `npm run verify:openmarket-provider` for real local provider reads. The latter verifies BTC discovery/candles, recommended buckets and one 1,000-level orderbook snapshot, recording advanced permission refusals separately. Reports are saved under ignored `artifacts/openmarket-*` paths.

For production, freeze the current sources with `scripts/freeze-opendots-release.py`, build the candidate and upload that stage to the dedicated ChatGPTEE service. Keep its `/data` volume and the existing Cloudflare edge configuration. Run `REGISTRATION_VERIFY_OPENMARKET=1 node scripts/verify-registration-live.mjs` against the normal `https://chatgptee.ai` hostname to verify a fresh authenticated account, live charts, the drawer on desktop/mobile, session restoration and logout. It generates a disposable authentication-only wallet and never signs transactions.

References: [OpenMarket candles](https://openmarket.xyz/docs/rest/candles), [Polymarket analytics](https://openmarket.xyz/docs/rest/polymarket-analytics).
