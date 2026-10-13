# ChatGPTEE documentation

A practical guide to your personal agent workspace: persistent Dots, editable Spaces, computer tools and reviewed Solana actions. This guide describes the implementation in this checkout. Provider availability, deployed releases and completed transactions must be verified in their own environment.

## Overview

ChatGPTEE is this project's current product name. The package and source repository retain the OpenDots name; some desktop tooling and older guides use Solana Dots. The application adapts the upstream CopilotKit OpenDots workspace with Solana identity, private accounts, wallet reviews and additional provider integrations.

A **Dot** is a persistent specialist with instructions and permissions. A **Space** holds editable pages and the project context those specialists can access. A **conversation** belongs to a Dot. Computers, MCP connections, memory and trading journals extend the Dot without turning every connected tool into an approved action.

| Surface          | What it does                                          | What enables it                                           |
| ---------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| Spaces and pages | Organize, edit and discuss project documents          | Workspace storage; a model for agent replies              |
| Dots and chat    | Persistent specialists, streaming answers, tools      | Configured text-model provider                            |
| Calls            | Realtime audio with compute delegation                | Voice provider and microphone permission                  |
| Computers        | Browser, files, terminal and human takeover           | E2B or OpenBot plus per-Dot permissions                   |
| Browser Use      | Cloud browsing tasks, live view and recordings        | Browser Use key and explicit permission                   |
| Solana workspace | Pump.fun, Jupiter, DFlow and wallet context           | Wallet/RPC/provider configuration as needed               |
| OpenMarket       | Crypto and Polymarket analytics                       | Data API key and provider entitlements                    |
| Trading brain    | Saved strategies, evidence, decisions, paper outcomes | Research/memory permissions and configured services       |
| External agents  | Privy device grants, wallet access and bounded x402   | Explicit account owner's grant, wallet policy and funding |

The intended public documentation URL is https://chatgptee.ai/docs. The four public product pages are /docs, /privacy, /terms and /service. Private product pages are gated at the server and frontend; login/registration, pairing and external-agent authorization remain narrowly scoped access utilities. The /docs page is public. Reading it does not sign you in, start a computer, grant an agent access or spend provider credits.

## Quick start

1. Open the workspace and choose **Create an account**, or sign in to an existing account. Social sign-in depends on the installation's configured providers; Solana sign-in proves ownership with a message.
2. Create a **Space** for a project. Add a page with a brief, source notes or a plan.
3. Create or edit a **Dot**. Give it a clear role and access to the relevant Space. Enable only the tools it needs.
4. Configure a text provider through native Settings or the server's environment. Open **New chat** and ask the Dot to work with that project.
5. Review any requested page creation, external tool action or transaction in its dedicated approval surface.
6. Return to the same conversation, page or activity view to inspect saved work.

Example prompt:

```text
Read the pages in my Launch Space. Draft a concise launch brief with a source list,
identify the missing inputs, and ask before calling any external write tool.
```

Spaces, wallet quote panels and computer controls have their own setup states. A missing model key does not make an independently configured wallet or computer provider available.

## Accounts and Solana identity

Public entry routes include /login, /signin, /register and /signup. The first successful wallet or social sign-in creates a private account and workspace. Returning users reopen their existing account.

Native Sign In With Solana is preferred, with an explicit message-signing fallback. The server validates the wallet, domain, URI, nonce, timestamps, signature and browser binding. Challenges last five minutes and are single-use. The UI checks the resulting server session before opening the workspace.

Hosted authentication combines Better Auth and verified Privy identities. Configured Google, X and GitHub identities can create accounts without a wallet; linking a wallet is an explicit later action. Accounts are not implicitly merged by matching email. Account linking requires a fresh session and rejects conflicting workspace ownership.

| Identity or credential         | Purpose                                                           |
| ------------------------------ | ----------------------------------------------------------------- |
| Account session cookie         | Open this user's private workspace                                |
| Connected Solana wallet        | Choose a public address and sign a specific reviewed transaction  |
| Existing workspace owner token | Open the installation's original owner workspace                  |
| Privy agent device grant       | Authorize a separate external agent within scoped wallet policies |
| Provider API key               | Call a configured service from the backend                        |

Connecting, changing or disconnecting the transaction wallet preserves the authenticated account. Signing in neither funds the wallet nor approves a transaction. **Sign out** revokes application sessions and disconnects the active wallet.

## Spaces, pages and the editor

Spaces provide project boundaries. Dots receive an explicit list of accessible Spaces; the backend checks that list for page tools and page conversations.

Create pages from the Space library or navigation. Pages can have nested subpages, titles and rich document content. The Tiptap editor supports headings, paragraphs, bullet and numbered lists, checklists, quotes, code blocks, dividers and tables. Type / at the start of a block to open the command menu.

Edits autosave through the page API. The page state and saved status matter: a local draft and a successful server save are different states. Keep the page open if a network error requires another save attempt. Markdown conversion and the page outline support readable documents and navigation.

Ask a Dot to turn a conversation into a page. The review card shows the proposed draft and target Space before creating it. Reviewed page writes are tied to their conversation and tool call; reusing the same approval does not create another page. Deleted approved pages are not silently recreated.

## Page conversations

A page's conversation includes bounded page context, keeping discussion close to the document being edited. Open its chat panel to ask for an explanation, outline or revision.

```text
Use the current page as context. Suggest three improvements to its opening
paragraph, then explain which claims need evidence before I publish it.
```

The conversation stays associated with the page and Dot. Permission checks apply when the page is read or saved, including after the Dot loses access to the Space. Page chat is not blanket permission to change every document.

## Dots, avatars and permissions

Use a Dot's settings to edit its name, role instructions, Space access, research and memory permissions, learning configuration, avatar, wallet and connected tools.

Avatars can be generated or edited with the configured xAI image service. Saved image bytes persist in the workspace database and appear across navigation, chat, calls and results. Generation consumes provider credits; a missing key or provider refusal is shown in the settings flow.

Workspace pause and global permissions combine with per-Dot permissions. Research, memory, computer capabilities and MCP tool settings are checked server-side. Changing relevant settings stops active work where supported and blocks subsequent actions. Cancellation cannot undo an external action that has already completed.

## Chat, tools and conversation history

Streaming chat uses the configured model provider for all Dots, page turns and scheduled conversation work. A Dot's instructions and accessible Space context stay attached to the conversation.

Without optional CopilotKit Intelligence, chat messages, tool results and state persist in local SQLite. "Local" describes the runtime's storage: for a hosted account that SQLite database lives on the server, while the Mac app keeps it on the user's device. Model requests still go to the selected external provider.

Tool results are untrusted context. Public research, X Search, page tools, computer actions, MCP tools, quotes and trading tools each retain their own permission and approval rules. X Search reads public posts through xAI; this integration does not post to X.

Closing a panel does not necessarily cancel a provider job. Use the corresponding stop control and inspect its saved status.

## Calls and voice compute

The call view uses a configured realtime voice provider and the selected conversation. The browser requests microphone permission and negotiates an audio session. Text chat credentials and voice credentials have separate roles.

During a call, **ask_compute** delegates longer work to the existing Dot conversation. The resulting text and call transcript can be persisted in that conversation. Audio connectivity, active-call state and a completed compute result are separate events.

Voice is not a wallet approval channel. It does not itself send messages, authorize payments or control the user's own machine. A telephone link opens the device dialer; the link alone is not evidence of an answering AI line.

## Scheduled tasks and activity

**Scheduled & activity** shows task work, progress and completed output. Scheduled conversation tasks run in their original Intelligence/local conversation through the same Dot and permission rules.

Task APIs support creation, actions and schedule changes. An interval must be at least 60 seconds. Pause or disable work from the workspace controls when it should stop. Saved schedules resume with the persistent workspace runtime; the process must remain running.

MCP tools marked **Ask first** cannot be approved through a scheduled turn or Slack. The Dot asks the user to continue in the web application. Interrupted tasks require an explicit Retry after reviewing their state, because earlier external effects may remain. Task success records a completed task result; it does not independently prove a provider transaction or on-chain settlement.

## E2B computers

E2B is the default computer provider. Each Dot can have its own desktop sandbox, browser profile and /home/user/opendots-workspace directory. Open **Computer**, enable computer access and the needed browser/files/shell capabilities, then choose **Start computer**.

The panel includes browser interaction, screenshots, files, terminal and activity. Commands run in the sandbox. The app does not fall back to the user's host shell when the service is unavailable.

**Take control** pauses agent input. After release or restart, the agent must obtain a fresh snapshot before using browser element references. Old references become stale after actions. Workspace file operations check relative paths and symlinks.

**Stop computer** pauses the E2B sandbox while retaining files and browser profile. Start resumes its saved sandbox. Timeouts also pause it; status polling does not provision or resume it. An unavailable provider is reported explicitly, and recreating a confirmed missing sandbox requires an explicit Start action.

```dotenv
COMPUTER_PROVIDER=e2b
E2B_API_KEY=REPLACE_ON_THE_SERVER
E2B_TEMPLATE=desktop
E2B_TIMEOUT_MS=300000
```

## OpenBot computers

Set COMPUTER_PROVIDER=openbot to use the included Docker supervisor. Keep lifecycle and computer secrets distinct, random and at least 24 characters. Keep the computer namespace stable so existing profile/workspace volumes remain associated with their Dots.

```dotenv
COMPUTER_PROVIDER=openbot
COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312
COMPUTER_SUPERVISOR_TOKEN=REPLACE_WITH_A_RANDOM_SECRET
COMPUTER_TOKEN=REPLACE_WITH_A_DIFFERENT_RANDOM_SECRET
COMPUTER_NAMESPACE=opendots
```

```sh
docker compose -f compose.computers.yml build computer-image computer-supervisor
docker compose -f compose.computers.yml up -d computer-supervisor
```

For a container-run app, use compose.computers-app.yml with compose.yml and compose.computers.yml so service DNS and the internal control network match. The supervisor alone mounts the Docker socket. Stop individual computers before stopping the supervisor when you intend to end their activity.

These containers use ordinary container isolation and share the host kernel. A separately installed runsc runtime can be selected; the project does not install it or promise restrictive network egress by default.

## Browser Use Cloud

Browser Use is a separate Computer tab with a separate per-Dot permission. It supports standalone recorded cloud browsers, hosted agent tasks, follow-ups, explicit stop controls and recording downloads.

```dotenv
BROWSERUSE_API_KEY=REPLACE_ON_THE_SERVER
BROWSER_USE_MODEL=gpt-6-luna
BROWSER_USE_WORKSPACE_ID=
CLAWD_PROFILE=
CDP_URL=
```

BROWSER_USE_API_KEY is an alias; a non-empty BROWSERUSE_API_KEY takes precedence. The original owner may use its configured profile/workspace or CDP connection. Signed-in private accounts get their own persisted cloud file workspace and do not inherit the owner's browser profile or supplied CDP endpoint.

Start a standalone browser for manual inspection. Start a hosted task with a non-empty instruction; continuing reuses the Dot's prior task session. The hosted task provisions its own browser, so an existing standalone browser or CDP_URL is a different connection.

Closing the panel does not stop billing. **Stop task**, **Stop cloud browser** and **Stop all cloud work** end the selected resources. Revoking permission, pausing the workspace and normal shutdown stop owned cloud work. Recordings can take time to become downloadable after stop. Provider readiness and an accepted job do not prove the task finished.

## MCP connections and human approval

In **Edit specialist → Connections**, enter a name, Streamable HTTP MCP endpoint and optional bearer token. Connect lists available tools; Refresh updates that list while preserving existing choices.

Tools start enabled. A server's readOnlyHint permits autonomous reads by default; other tools start with **Ask first**. The hint is supplied by the remote server. Enable Ask first for any tool you want to review.

An approval stores the exact connection, tool and arguments in the workspace. The chat card shows those stored arguments. **Approve & run** executes only that saved request, verifies the conversation's Dot still has the tool enabled and allows at most one execution. Requests expire after an hour. Saved receipts distinguish pending, running and completed actions.

```text
MCP endpoint: https://your-service.example/mcp
Authentication: optional server-stored bearer token
Tool policy: enabled + Ask first for changes you want to review
```

Tokens stay in server SQLite and are not sent back to the browser. Signed-in accounts can connect to public HTTP(S) destinations; private network addresses and redirects are rejected and DNS results are pinned. The original owner can additionally configure local servers. OAuth-only MCP servers are not supported by this connection form; use a compatible token-based endpoint.

## Memory and learning

Conversation history, editable workspace memories and provider-extracted long-term memory are separate features.

Mem0 adds recall across new conversations for the same scoped owner/Dot. It requires configuration, both global and Dot memory permission, and an unpaused workspace. The server fetches relevant memories as untrusted context. Completed turns enter a durable local outbox; extraction uploads and provider jobs retry with backoff and survive restarts. This is at-least-once delivery, so a crash during acceptance can resubmit a turn. Historical chats are not automatically backfilled.

```dotenv
MEM0_API_KEY=REPLACE_ON_THE_SERVER
MEM0_BASE_URL=https://api.mem0.ai
MEM0_ORG_ID=
MEM0_PROJECT_ID=
```

The Mem0 status view separates configuration, recall and indexing progress. Its local relevant-memory cache can support temporary provider failure; it is not proof the remote index has completed.

Optional **Automatic Learning** uses CopilotKit Intelligence learning containers and skill delivery. A Dot needs a valid lowercase container ID when skill delivery is enabled. Generated skills and learning are separate from Mem0 facts and Trading Brain paper-policy adaptation.

## Wallets and custody

The connected browser wallet, encrypted OWS local Dot wallet and Privy embedded wallet have distinct control paths.

| Wallet                  | Where signing happens                          | Intended use                                                 |
| ----------------------- | ---------------------------------------------- | ------------------------------------------------------------ |
| Connected Solana wallet | User's compatible browser wallet               | Explicitly reviewed Pump/Jupiter transactions                |
| OWS local wallet        | Native OWS core within the local/owner runtime | Encrypted Dot wallet, explicit credential and signing review |
| Privy embedded wallet   | Privy's authorization/signing infrastructure   | User-granted external agent RPC and bounded API payments     |

The hosted Pump workflow uses a connected browser wallet; local-wallet Pump signing is enabled by the Mac runtime. Generic OWS signing routes still require an authenticated workspace, an explicit credential and confirmation in the runtime holding that encrypted vault. The wallet editor can create/import an encrypted wallet, attach it to a Dot, copy public receive addresses, manage scoped keys/policies and review explicit signing requests. Creating a wallet does not fund it.

An OWS owner passphrase bypasses OWS policies by design; an api_token enforces its wallet scope and policy before decryption. The app rejects credential-type mismatches and does not retry a denial with owner credentials. The signer shares the application's address space. It does not return decrypted private keys to a model or agent.

**Sign only** and **Sign and broadcast** are separate choices. Connected-wallet sign-in requests a message proof; browser transaction signing requests a specific reviewed transaction. Agents only receive public addresses or the explicitly authorized capability.

## Pump.fun launches and trades

Open **Pump.fun** directly from the sidebar or the Solana workspace. Inspect a full mint address, prepare a buy/sell or prepare a launch. Panel actions do not require a chat model.

Launch input includes name, symbol and an HTTPS public metadata JSON link with description/image. The integration prepares supported SOL-paired Token-2022 coin creation with the chosen payer/creator, an optional initial buy and the protocol's holder-reward choice. Check permanent settings in the exact review before approval.

Pump uses the official Pump and PumpSwap SDKs, supported bonding-curve trades and the canonical migrated PumpSwap pool. Token decimals, fee configuration and quote asset come from the actual chain data. Buy amounts use quote units; sell amounts use token units.

```text
Inspect this exact mint: <SOLANA_MINT>.
Prepare a buy of 0.01 SOL with 1% slippage, show the full review,
and wait for my wallet approval.
```

The private review includes wallet, mint, amounts, slippage, fees, estimated debit, simulation and expiry. The server stores immutable transaction bytes. Changing inputs/wallet requires fresh preparation. Submit verifies the signed transaction matches the exact review and preserves single-use submission.

A submitted signature is distinct from a confirmed chain receipt. An uncertain network outcome remains uncertain while the app checks the signature. Quotes and prepared unsigned bytes do not prove a launch, purchase or sale.

## Jupiter swaps and DFlow quotes

**Jupiter** provides managed Order quotes and advanced Build mode. Order uses provider routing/landing; Build exposes fast routing, automatic RTSE or fixed slippage and a maximum account count. Review displays the resulting minimum output, fees, routing, required signers, message, simulation and expiry.

This integration requests Solana version 0 transactions for the installed wallet stack. Provider-supplied deferred signatures are accepted only when specifically declared and validated. A managed execute call is not automatically repeated after an ambiguous result. Only independently confirmed or finalized chain evidence becomes confirmed.

The jupiter_quote chat tool displays a read-only card. prepare_jupiter_swap requests a private review when the interactive review surface is present. Wallet signing is not a model tool.

```json
{
  "input": {
    "inputMint": "So11111111111111111111111111111111111111112",
    "outputMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    "amount": "0.01",
    "mode": "order",
    "slippageBps": 100
  }
}
```

This is a quote request for POST /api/markets/jupiter/quote in a signed-in workspace. Preparing requires the selected public address and a separate route. SOL must cover applicable fees and rent; each wallet approval remains explicit.

**DFlow** calls its configured synchronous /order endpoint for indicative spot comparisons. Cards expose expected/minimum output, slippage, verified SOL platform fee and expiry. They contain no transaction bytes and do not execute prediction-market orders. Pump/Jupiter preparation has its own review and fees.

## OpenMarket analytics

The OpenMarket drawer covers crypto instrument discovery, candles, open interest, funding, orderbooks, volume profiles, TPO, liquidation/trigger heatmaps and options. The Polymarket views expose leaderboards, trader profiles, positions, markets, categories and distributions.

Select the actual venue/instrument before loading a dataset. Orderbook buckets can use provider recommendations; cross-exchange summed USD volume is charted separately because that response does not provide valid price OHLC. Bounds include 200 candles or 20 heatmap snapshots, 1,000 levels and a 4 MB response.

```dotenv
OPENMARKET_API_KEY=REPLACE_ON_THE_SERVER
```

The openmarket_data Dot tool is read-only and requires both workspace and Dot research permission. The Data API key and Indicator Access membership are separate products. A 403 reports entitlement denial; 429 reports quota refusal. Failed datasets are not silently replaced with another source.

Analytics neither sign nor execute trades. A provider observation time identifies freshness, not a guaranteed fill or price.

## Birdeye token and wallet research

Birdeye adds read-only token discovery, market prices, candles, security evidence, large trades and public-wallet PnL research to permitted Dots. Set the server-only credential or save it in native encrypted **Provider connections → Birdeye** settings:

```dotenv
BIRDEYE_API_KEY=REPLACE_ON_THE_SERVER
```

The server supplies `x-api-key` authentication to the official Beta MCP at `https://mcp.birdeye.so/mcp` and `X-API-KEY` plus `x-chain: solana` to the Data API. Dots discover current schemas with `birdeye_mcp_catalog`, then call an explicitly read-only discovered tool with `birdeye_mcp_call`. `birdeye_meme_detail` reads a mint directly. Beta tools and limits may change. Both workspace and Dot research permission apply; hosted users share the configured account's quota while their conversations stay private.

The additional authenticated APIs are `GET /api/birdeye/mcp/catalog?threadId=...` (optional `search`), `POST /api/birdeye/mcp/call` with `{threadId,name,arguments}`, and `GET /api/birdeye/meme-detail?threadId=...&address=...`. Each conversation must belong to the active workspace and permit research. A successful MCP initialization is separate from completed session verification, catalog discovery and tool execution.

Use exact public mint or wallet addresses and retain observation times, missing fields and provider errors. New listings and smart-money flows are candidates for research. Security flags are evidence rather than a safety guarantee; closed candles and meaningful pool volume are needed before trusting a threshold or spread. Wallet signing remains in the existing explicit review flow.

The requested meme-detail dataset is `GET /defi/v3/token/meme/detail/single` for mint `HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump`. A placeholder-only reference request is:

```sh
curl --request GET \
  --url 'https://public-api.birdeye.so/defi/v3/token/meme/detail/single?address=HHuLN58RAJoyNxwYte8NdEyV7dhQzDCLXDmTraHspump' \
  --header 'X-API-KEY: <api-key>' \
  --header 'x-chain: solana'
```

Use the server integration for the real credential. [Birdeye's official tool catalog](https://data.birdeye.so/docs/agents/tool-catalog) maps tasks to datasets. Configuration, live MCP discovery, a REST response and a model reply using the tool establish separate evidence; account credit and dataset entitlements still apply.

## Trading Brain

The selected Dot's **Trading brain** combines persistent strategies, source evidence, decisions, a journal, a graph and optional recall. Chat tools include save_trading_strategy, trading_brain, trading_journal and monitor_trading_strategy.

SQLite stores owner/Dot-scoped strategy versions, decisions, paper observations, monitor expiry and a retryable Supermemory outbox. Mem0 conversation memory remains independent. Supermemory indexing is complete only after the provider confirms it.

```dotenv
SUPERMEMORY_API_KEY=REPLACE_ON_THE_SERVER
TYPESAFE_API_KEY=REPLACE_ON_THE_SERVER
JUPITER_API_KEY=OPTIONAL_SERVER_KEY
```

The configured Pump and CLAWD feeds report connection state and freshness separately. Token announcements are observations; priced pool evidence comes from configured market services. Exact mint addresses preserve token identity.

TypeSafe evaluates closed action/risk/strategy/evidence questions. Monitoring is opt-in: once per minute for one hour, up to 60 successful decisions per Dot/day and 10 evaluations per workspace/minute. It stops on workspace pause or revoked research/memory permission.

Eligible decisions require fresh priced liquidity evidence and saved thresholds. **Review** validates current strategy, freshness, owned conversation and spend cap before requesting the existing Pump review. The brain never automatically trades.

Later paper outcomes compare actual observed prices, excluding fees, slippage and execution. Sufficient observed losses may raise the confidence threshold, up to 0.99; it does not lower it. This is policy adaptation, not model training or realized profit.

## Muse Wonder, OpenRouter and Claude batches

The source default is OpenRouter with [Muse Wonder](https://openrouter.ai/meta/muse-wonder) (`meta/muse-wonder`). Use the exact model required by your provider account; a local default does not prove provider availability.

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=REPLACE_ON_THE_SERVER
OPENROUTER_MUSEMODEL=meta/muse-wonder
OPENROUTER_CLAUDE_MODEL=anthropic/claude-haiku-5.5
```

`OPENROUTER_MUSEMODEL` controls synchronous chat. After trimming whitespace, the server uses that setting, then the legacy `OPENROUTER_MODEL`, then `meta/muse-wonder`. `OPENROUTER_CLAUDE_MODEL` controls batches only. A `:batch` slug cannot power interactive chat and is rejected for that setting. Keep `OPENROUTER_API_KEY` on the server; it is never a browser variable.

**Claude batches** accepts up to 50 prompts, separated by blank lines, with a provider completion window of 24 hours. Up to three local jobs can be active. Jobs persist in the user's database; closing/reopening resumes polling. Provider retention follows the Batch API contract.

Repeated submission with a request ID is deduplicated. An unknown paid submission outcome is recorded for review rather than retried automatically. Batch results are text and do not execute tools or wallet actions.

Explicit MODEL_PROVIDER=xai selects Grok via XAI_API_KEY/XAI_MODEL; openai selects OPENAI_API_KEY/OPENAI_MODEL/OPENAI_BASE_URL. Extra XAI_API_KEY can enable X Search and avatars alongside OpenRouter chat.

## Phone, Slack and messaging

Phone pairing connects a companion browser to the existing Mac workspace with a one-use pairing code. The Mac runtime must remain running and reachable through its configured trusted network or relay. Pairing does not upload a second workspace. Provider settings, wallet signing and restricted controls remain on the Mac.

Slack Channels is an optional configured transport. Its owner mappings and browser profile remain in the original owner workspace; private accounts do not inherit them. Scheduled/Slack compute uses the same Dot permissions.

Spectrum messaging is a separate optional Photon Stable transport for Telegram and cloud iMessage. Enable only a newly authorized project/bot/line with its own credentials and registration/line-ownership flags. Provider configuration defaults off.

Use **Phone → messaging** to link a channel and Dot. A ten-minute one-use code must arrive by direct message from the identity being linked. Routing binds the signed-in account, selected Dot and exact provider space/line. Groups, duplicates, echoes and unsupported event types are excluded.

Messages are not wallet approvals. A provider-ready status and successful link control do not prove a live incoming message/reply. The displayed voice phone number is separate from an iMessage line; the application does not read the local macOS Messages database.

## External agents and x402

Open /authorize to review external-agent device grants, authorized wallets and revocation. Workspace sign-in and external-agent authorization are distinct.

```sh
npm install -g https://chatgptee.ai/agent/chatgptee-agent-0.1.1.tgz
chatgptee-agent login
chatgptee-agent list-wallets
chatgptee-agent logout
```

The login flow displays a verification URL/code. The account owner approves it in the browser. The CLI uses operating-system credential storage; Linux requires a working Secret Service keyring. It fails if secure storage is unavailable. Local logout removes its credentials; revoke the grant in /authorize to revoke delegated access. Previously issued access tokens can remain valid until expiration, up to 15 minutes.

Wallet RPC remains subject to the owner's grant, intent and wallet policies. A grant is not authorization for unrelated payments.

The browser x402 panel accepts allowlisted CoinGecko/Allium HTTPS APIs and supported exact USDC offers on Base/Solana networks, including supported testnets. It shows network, token, recipient, amount and resource before an explicit payment. Per-request maximum is at most 1 USDC. It rechecks the exact offer before signing.

The CLI supports x402 v2 and its own explicit per-request cap. Agent access does not fund wallets. Fund the chosen embedded wallet on the offer's network and inspect a facilitator/chain receipt before reporting settled payment. No provider secret or Privy bearer token is forwarded to the API.

## Provider configuration

All credential values below belong in the server environment or native encrypted Settings. Never place private credentials in a VITE_ variable, a page, model prompt or browser bundle. Native settings use Keychain-backed encryption on macOS.

| Capability              | Server settings                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ |
| Hosted identity         | DATABASE_URL, APP_ORIGIN, BETTER_AUTH_URL, BETTER_AUTH_SECRET, OWNER_TOKEN                                   |
| Privy bridge and grants | PRIVY_APP_ID, PRIVY_CLIENT_ID, PRIVY_APP_SECRET, PRIVY_AUTH_ORIGIN                                           |
| Live text               | MODEL_PROVIDER and OPENROUTER_API_KEY / XAI_API_KEY / OPENAI_API_KEY plus the selected model                 |
| Optional Intelligence   | COPILOTKIT_INTELLIGENCE_API_KEY / CPK_INTELLIGENCE_API_KEY / INTELLIGENCE_API_KEY as accepted by the runtime |
| Voice                   | VOICE_API_KEY, VOICE_MODEL, VOICE_NAME                                                                       |
| Public web research     | WEB_SEARCH_PROVIDER, PARALLEL_API_KEY                                                                        |
| Browser sidecar         | BROWSER_URL, BROWSER_SECRET                                                                                  |
| Dot computers           | COMPUTER_PROVIDER plus E2B or OpenBot settings                                                               |
| Browser Use             | BROWSERUSE_API_KEY, BROWSER_USE_MODEL and owner-only profile/CDP options                                     |
| Mem0                    | MEM0_API_KEY, MEM0_BASE_URL, MEM0_ORG_ID, MEM0_PROJECT_ID                                                    |
| Solana                  | SOLANA_RPC_URL, JUPITER_API_KEY and optional DFLOW_API_KEY/configuration                                     |
| OpenMarket              | OPENMARKET_API_KEY and provider entitlements                                                                 |
| Birdeye                 | BIRDEYE_API_KEY for official Beta MCP and Solana Data API research                                           |
| Trading Brain           | SUPERMEMORY_API_KEY, TYPESAFE_API_KEY and configured market services                                         |
| Spectrum messaging      | SPECTRUM_MESSAGING_ENABLED, project, selected bot/line credentials and explicit activation flags             |

Hosted auth requires PostgreSQL (the supplied deployment supports Supabase) while user workspace data stays in per-user SQLite under USER_DATA_PATH. Provider keys are optional per capability; a disabled feature should show its actual configuration state.

## Local setup and development

Use Node.js 24 or later. Install from this exact checkout so frontend, backend and trading adapters match.

```sh
npm ci
cp .env.example .env
# Edit .env privately with your database, authentication and chosen providers.
npm run dev
```

The API defaults to 127.0.0.1:4310. Vite listens on 127.0.0.1:3460 and proxies /api. Use the exact browser origin permitted by your authentication configuration (for example localhost:3460) and set BETTER_AUTH_URL to it.

The hosted server initializes PostgreSQL identity tables before accepting traffic. Public docs can be previewed with npx vite even before private database/provider setup. Conversation readiness appears in Settings; optional Intelligence cloud/local licensed services have separate setup from local conversation storage.

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

Build emits dist/client and dist/server and copies native trading adapters. npm start uses the compiled Node server. The downloadable documentation and article are generated from the same Markdown sources as the public page.

## API usage and contracts

Use same-origin /api routes with a verified account cookie, or the original installation's owner bearer token where explicitly supported. Browser mutating requests require application/json and a permitted Origin. Do not put tokens in URLs.

Public docs do not change private API authentication. Workspace IDs, Dot IDs, conversation IDs and review IDs are scoped to the authenticated workspace. Replace example identifiers with owned values.

Read-only example from a signed-in browser:

```javascript
const response = await fetch('/api/workspace', { credentials: 'same-origin' });
const body = await response.json();
if (!response.ok) throw new Error(body.error || 'Workspace request failed');
console.log(body.spaces, body.dots);
```

Create a Space:

```javascript
const response = await fetch('/api/spaces', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Launch', description: 'Project notes' }),
});
const space = await response.json();
if (!response.ok) throw new Error(space.error || 'Could not create Space');
```

Create a conversation after selecting a configured Dot:

```json
{ "dotId": "YOUR_OWNED_DOT_ID", "title": "Launch planning" }
```

POST /api/conversations returns the created conversation with 201. Page creation accepts title (1–160 characters), content (Markdown, up to 100,000 characters) and nullable parentId. Updates accept changed title/content/parentId plus a positive expectedRevision; a stale revision returns a conflict. Use the latest revision when saving. Example POST /api/spaces/YOUR_SPACE_ID/pages:

```json
{
  "title": "Launch brief",
  "content": "# Launch\\n\\nOur first draft.",
  "parentId": null
}
```

Example PATCH /api/spaces/YOUR_SPACE_ID/pages/YOUR_PAGE_ID:

```json
{ "content": "# Launch\\n\\nThe revised draft.", "expectedRevision": 1 }
```

Computer actions use an action plus its validated inputs. Connection approvals use their saved tool-call/approval identity and approved decision, never replacement tool arguments.

| Status    | Meaning to handle                                                  |
| --------- | ------------------------------------------------------------------ |
| 200 / 201 | Successful response / created resource; inspect the returned state |
| 400       | Invalid input or unsupported operation                             |
| 401       | Missing, revoked or expired account/owner authorization            |
| 403       | Origin, permission, workspace or provider-entitlement denial       |
| 404       | Unknown or unavailable owned resource                              |
| 409       | Conflict, stale state or a review that cannot be reused            |
| 413 / 415 | Request too large / JSON content type required                     |
| 429       | Rate or quota limit                                                |
| 502 / 503 | Provider or configured service unavailable                         |

Streaming /api/copilotkit routes carry the agent runtime protocol; they are not plain chat-JSON endpoints. The auto-generated route reference below covers first-party Hono routes and custom auth endpoints. Better Auth also owns its standard session/social/OAuth protocol behind /api/auth/*; use the installed auth client rather than inventing those request bodies.

## Hosting, containers and desktop packaging

The included hosted topology runs Node on Railway or another persistent Node host and Cloudflare as the public edge. deployment/chatgptee-edge.mjs forwards app/API paths without buffering SSE, serves /logo.png and /agent/* from its asset binding and preserves the trusted authentication proxy boundary. /docs and guide downloads use the same app upstream.

deployment/Dockerfile.chatgptee builds the app and runs it with /data persistence. The original Dockerfile also includes app and Playwright browser targets. Compose definitions add local app/browser and optional OpenBot services.

```sh
docker build -f deployment/Dockerfile.chatgptee -t chatgptee .
```

Before a real deployment configure a random owner token of at least 24 characters for external binding; exact APP_ORIGIN/BETTER_AUTH_URL, matching Privy origins/custom auth CSP and the edge proxy secret; PostgreSQL connectivity; and a persistent /data volume. Keep DATABASE_PATH, USER_DATA_PATH, OWS_VAULT_PATH, OWNER_ID, computer namespace and persistent Better Auth secret stable.

Preserve existing route/binding configuration and provider secrets when publishing an edge change. A built image or healthy edge does not prove OAuth callbacks, DNS, model replies or computer provisioning.

```sh
npm run desktop:build
npm run desktop:package
```

Desktop builds copy the same dist/client assets, including /docs, into the native runtime. Signing/notarization needs the owner's Apple configuration and explicit release work. Packaging locally does not publish or replace a signed app.

## Storage, privacy and observability

| Data                                                | Storage or service                   |
| --------------------------------------------------- | ------------------------------------ |
| Identity, challenges, sessions and linked accounts  | Hosted PostgreSQL                    |
| Pages, Dots, chats, schedules and provider outboxes | Runtime workspace SQLite             |
| Local Dot wallet secrets                            | Encrypted OWS vault                  |
| Native provider configuration                       | OS-backed encrypted desktop settings |
| Model requests                                      | Selected model provider              |
| Long-term facts / trading retrieval                 | Optional Mem0 / Supermemory          |
| Browser profiles and computer files                 | Selected sandbox/cloud provider      |

Protect workspace databases along with server credentials: MCP bearer tokens and other private workspace state can reside there. The browser receives public configuration and scoped data, not server keys. A hosted account's server-side SQLite is not device-only storage.

The package includes optional setup/SDK usage telemetry. Set DO_NOT_TRACK=1 or COPILOTKIT_TELEMETRY_DISABLED=true to opt out of SDK telemetry as implemented. Telemetry, operational logs, provider usage and paid-service retention are distinct. Computer audit history omits typed values, file contents and full commands; retained metadata is still private workspace data.

## Troubleshooting and verification

| Symptom                                      | Check                                                                                                           |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Docs work but the workspace asks for sign-in | Expected public/private boundary; establish a real account session                                              |
| Sign-in loops or provider callback fails     | Exact browser origin, callback, selected Privy app/client, custom auth origin/CSP, secure cookie and PostgreSQL |
| Chat says setup required                     | Chosen live provider key/model; separate voice and optional Intelligence credentials                            |
| Computer is unavailable                      | Provider key/service, network, permissions, saved sandbox, supervisor image/token/namespace                     |
| Browser task is accepted but not complete    | Its run state, recording readiness and explicit stop controls                                                   |
| MCP call waits for approval                  | Open its saved chat card; verify tool still enabled and the request has not expired                             |
| OpenMarket returns 403 / 429                 | Data API entitlement / quota; do not substitute a dataset                                                       |
| Memory stays queued                          | Provider configuration, permissions and extraction/index completion                                             |
| Old transaction cannot sign                  | Reprepare after expiry, wallet/input changes or stale blockhash                                                 |
| Submitted trade has no confirmation          | Inspect independent on-chain status; do not resubmit an ambiguous request automatically                         |
| Messaging remains unavailable                | Activation flags, new project/bot/line ownership, credentials and exact account link                            |

Local fixture tests validate policy and state transitions. Real providers require separate evidence: complete OAuth return into the intended private account; a live model reply; provisioned computer with pause/resume and takeover; actual scoped MCP tool completion; exact unsigned review; explicit user wallet approval; independent confirmed chain receipt.

Read scripts before running live verifiers. Several create temporary sandboxes, registered accounts or paid provider requests; some configure provider webhooks. Keep those distinct from local docs/build tests.

The public route reference is assembled from current allowlisted backend source files at build time, avoiding an API list copied from an older release.
