# ChatGPTEE Service

Updated: October 11, 2026. ChatGPTEE is a personal agent workspace built as a Solana-focused adaptation of OpenDots. This page explains what the implemented service offers, what needs configuration and how access is controlled.

## The workspace

Dots are persistent specialists with instructions, avatars and explicit tool/Space permissions. Spaces hold editable pages and nested project documents. Conversations, page discussions, saved drafts and scheduled activity preserve the work behind a project.

The text model is configured by the operator or native user. Local conversation storage uses the runtime's SQLite workspace; a hosted account's database lives on the server, while the Mac app keeps its workspace on the device. Model inference and enabled tools can still use remote providers.

## Included feature surfaces

| Surface                      | Purpose and dependency                                                                                               |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Spaces and editor            | Rich pages, nested documents, autosave, outlines and reviewed page creation                                          |
| Dots and chat                | Persistent specialist roles, streaming tools and private conversation history; configured model required for replies |
| Calls and scheduled work     | Realtime voice and conversation-bound compute; voice/runtime setup and active hosting required                       |
| Computers                    | Per-Dot browser, files, terminal, activity and human takeover through E2B or OpenBot                                 |
| Browser Use                  | Separate cloud browser/task sessions, follow-ups, live view and recordings                                           |
| MCP connections              | Per-Dot remote tools with current permissions and saved Ask first approvals                                          |
| Memory and learning          | Optional scoped Mem0 recall, workspace records and Intelligence learning features                                    |
| Solana workspace             | Pump.fun preparation, Jupiter swaps, DFlow indicative quotes and wallet context                                      |
| OpenMarket and Trading Brain | Read-only market datasets, saved strategy/evidence journals and bounded monitoring                                   |
| Phone and messaging          | Limited companion pairing plus separately configured Slack/Telegram/cloud-iMessage transports                        |
| External agents and x402     | Explicit Privy device grants, scoped wallet RPC and reviewed bounded USDC API payments                               |

A surface appearing in the interface does not prove a provider is configured, entitled, provisioned or working. Each integration reports its own state.

## Public pages and private access

The four public product pages are:

- [Documentation](https://chatgptee.ai/docs)
- [Privacy](https://chatgptee.ai/privacy)
- [Terms](https://chatgptee.ai/terms)
- [Service](https://chatgptee.ai/service)

The account workspace and other product pages require authentication at the server and in the application. Anonymous visits to the root are directed to documentation; other private page entries require sign-in.

Necessary access utilities remain reachable: /login, /signin, /register and /signup establish an account; /pair and /connect accept a valid one-use companion proof; /authorize lets an account owner review an external-agent grant. None opens private workspace data or grants a capability merely because it rendered.

Authentication/API callback protocols, /healthz and the static assets/document downloads needed by these pages are protocol or resource endpoints. Their route-specific proofs, origin checks, request validation and scopes remain in force. Unknown documentation/static files do not return the private application shell.

## Accounts and hosted operation

Native Solana sign-in verifies a wallet ownership message. Configured social/Privy sign-in is verified server-side and can establish an account without a funded wallet. A fresh session is required for explicit account linking.

Hosted account metadata uses PostgreSQL. Each user has a separate persistent workspace and OWS vault on the Node host. The included deployment uses a Cloudflare edge forwarding to a persistent Node application, without buffering the agent stream. The edge is not the workspace database.

Self-hosted administrators choose hosting, secrets, providers, backups and supported access methods. Keep persistent paths, identity mappings and authentication configuration stable across updates.

## Native and companion operation

The Mac app packages the same frontend and local runtime. Provider credentials use its encrypted native Settings. The desktop process supplies a local authenticated context; a general browser visiting its port does not gain the owner's workspace merely by finding the URL.

Companion pairing requires a one-use code and a valid device session. Its API scope is narrower than the Mac owner's scope. Wallet signing, provider settings and other restricted controls remain on the Mac. The Mac/runtime must stay running and reachable for continued companion use.

## Wallet actions and agent access

The browser wallet, OWS runtime wallet and Privy embedded wallet have different signing/authorization paths. The hosted Pump workflow uses a connected browser wallet; local-wallet Pump preparation/signing is enabled by the Mac runtime. Generic OWS signing requires the authenticated workspace, explicit credential and confirmation in the runtime holding the vault.

Pump/Jupiter reviews bind approval to the stored transaction and selected wallet. Changing inputs, expiry or wallet requires fresh preparation. The Trading Brain can prepare a review when eligible; it never automatically executes a trade.

External-agent device authorization is separate from workspace sign-in. The owner reviews the grant and can revoke it. An x402 API request reviews its supported offer and explicit limit before payment. Wallet creation, funding, grant approval, signing, submission and settlement are separate states.

## Provider setup, charges and limits

Configure only the capabilities you intend to use. Model providers, E2B/Browser Use, memory, voice, research, messaging, market data and wallet/RPC services can require their own credentials, credits, plans or entitlements. Private keys stay out of client build variables and public documents.

This source does not advertise an operator subscription price, automatic renewal or universal free tier. Actual charges and cancellation terms must be stated in the operator's offer or selected provider's contract before acceptance.

Cloud browsers and batch jobs may continue after their panels close. Use the cloud browser's explicit stop controls to end its resources. Active batch cancellation is not supported; the provider completes, fails or expires the job, and terminal jobs have a separate deletion workflow. Trading monitoring is opt-in and bounded. x402 payment review enforces the implementation's per-request maximum of no more than 1 USDC, in addition to the selected wallet/grant policies. A separately approved agent wallet grant can allow wallet RPC actions beyond the x402 fetch payment cap.

## Availability and verification

The service reports configuration errors, provider refusals, quotas, uncertain submissions and stale reviews. An unavailable integration should remain visibly unavailable rather than silently substituting an unrelated source.

Builds and local fixture tests validate the implementation; production DNS, account callbacks, provider responses, computer provisioning, incoming-message delivery and chain settlement require their own evidence. Neither a ready page nor an accepted provider job establishes completion.

The ChatGPTEE name does not promise a hardware trusted execution environment or attestation. Supported sandbox isolation and credential protection are described in the documentation.

## Support and privacy requests

CLAWD operates ChatGPTEE at https://chatgptee.ai. Contact [clawdbot@mail.grokbot.com](mailto:clawdbot@mail.grokbot.com) for support, access incidents and account/privacy requests. Supply public identifiers and bounded diagnostic information, and describe the affected feature and time. Keep private keys, recovery phrases, tokens and provider credentials out of the request.

A self-hosted administrator operates its own deployment and should provide its own contact and any applicable jurisdiction-specific terms.

Read the [complete guide](https://chatgptee.ai/docs) for setup and troubleshooting, the [privacy policy](https://chatgptee.ai/privacy) for data flows and retention, and the [terms](https://chatgptee.ai/terms) for account and service responsibilities.
