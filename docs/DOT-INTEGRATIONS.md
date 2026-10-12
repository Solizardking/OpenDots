# Dot integrations

ChatGPTEE reads provider credentials on the server from its ignored `.env` file. Keep that file private. No provider API key is included in the browser bundle or sent to a Dot's desktop.

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_API_KEY=
OPENROUTER_MODEL=anthropic/claude-haiku-5.5
# Optional xAI credentials for avatars and X Search.
XAI_API_KEY=
XAI_MODEL=grok-4.7
XAI_IMAGE_MODEL=grok-imagine-image-2.0
COMPUTER_PROVIDER=e2b
E2B_API_KEY=
E2B_TEMPLATE=desktop
E2B_TIMEOUT_MS=300000
OWS_VAULT_PATH=data/ows
```

Restart `npm run dev` after changing these values. The web app runs at http://127.0.0.1:5173; the API runs at http://127.0.0.1:4310. A built app uses `npm run build` followed by `npm start` on port 4310.

## Claude for every Dot

All specialists use the same server configuration, including new Dots, page conversations, scheduled turns, and Slack compute turns. The default is `anthropic/claude-haiku-5.5` through OpenRouter's streaming Chat Completions API. Set the server-only `OPENROUTER_API_KEY`; `OPENROUTER_MODEL` selects the live model. Client messages cannot override the model or server instructions. See [OpenRouter setup](OPENROUTER.md) for live chat and separate batch jobs.

Dots with public research permission and a separate `XAI_API_KEY` can use `search_x`, including while Claude powers their chat. It calls the xAI X Search tool using Grok and returns source URLs; it cannot post to X. Existing public-web tools and their permissions remain available.

Conversation history persists locally in SQLite. Optional cloud persistence uses `CPK_INTELLIGENCE_API_KEY` or `INTELLIGENCE_API_KEY`; model credentials are separate from CopilotKit project credentials. To use an existing hosted project, sign in with `npx copilotkit login`, list projects with `npx copilotkit project list`, and select it with `npx copilotkit project select`. Avatar generation, wallet settings, and computer controls do not require that project key. [Mem0 memory](DOT-MEMORY.md) provides separate long-term recall for permitted Dots.

An explicit `MODEL_PROVIDER=xai` selects Grok using `XAI_API_KEY` and `XAI_MODEL` (default `grok-4.7`); its adapter uses the Responses API with streaming and `store: false`. An explicit `MODEL_PROVIDER=openai` retains the OpenAI-compatible alternative configured by `OPENAI_API_KEY`, `OPENAI_MODEL`, and `OPENAI_BASE_URL`.

References: [Grok Responses](https://docs.x.ai/developers/model-capabilities/text/generate-text), [X Search](https://docs.x.ai/developers/tools/x-search).

## Generate and edit your avatar

Open **Edit specialist** or the Dot's sidebar settings button. Describe its look and choose **Generate avatar**. Once an avatar exists, describe a change and choose **Edit this avatar**. Choose **Save** to apply it, or **Use original Dot** to restore its original illustration.

Generation uses `POST /v1/images/generations`; editing uses `POST /v1/images/edits` with JSON and the previous image as a data URI. Both request base64 output from `grok-imagine-image-2.0`. The server stores image bytes in SQLite, so provider image URL expiry does not affect saved avatars. The generated avatar appears in navigation, chats, calls, and results. The browser fetches avatar data through the application's existing owner authentication.

Generation and editing use xAI credits. Provider rejection, quota errors, and interruptions are shown in the settings dialog. The original illustration remains available while a saved image loads.

References: [Image generation](https://docs.x.ai/developers/model-capabilities/images/generation), [JSON image editing](https://docs.x.ai/developers/model-capabilities/images/editing).

## OWS wallet

The Dot settings **Wallet** section can select a wallet, create an encrypted wallet, import a recovery phrase or hex Solana private key, copy receive addresses, review and sign a message or transaction, and create or revoke scoped agent access. Save the settings to attach the chosen wallet to that Dot. Creating a wallet does not fund it.

The backend uses `@open-wallet-standard/core`, the reference Rust implementation, in-process (OWS access Profile A). Signing and policy evaluation stay inside that core. The application and signer share an address space. Decrypted mnemonic and private key material are never returned to the browser or agent. Backup and recovery use the encrypted vault and your passphrase; this app does not expose a secret-export endpoint.

Signing credentials have an explicit type: `owner` or `api_token`. An owner passphrase bypasses OWS policies, as specified by OWS. An `ows_key_` token enforces its wallet scope and attached policies before decryption. Mismatched credential types are rejected; a denial is never retried with owner credentials. Signing requests resolve chain aliases to canonical CAIP-2 IDs, and errors include a bounded message and canonical code. All wallet routes use the app's existing owner-token and origin checks.

The Dot can read its assigned wallet's public receive addresses through `get_dot_wallet`. Signing stays in the owner settings UI with an explicit review checkbox. **Sign only** returns a signature; **Sign and broadcast** is a separate selected operation and returns a transaction hash only after the OWS transport reports success.

| Route                                                                                                                      | Capability                                                                                     |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /api/wallets`, `GET /api/wallets/:id`                                                                                 | List and select public wallet descriptors                                                      |
| `POST /api/wallets`, `POST /api/wallets/import`                                                                            | Create and import encrypted wallets                                                            |
| `DELETE /api/wallets/:id`                                                                                                  | Delete a detached wallet with `confirm: true`                                                  |
| `POST /api/wallets/:id/sign`                                                                                               | `sign`, `signMessage`, `signTypedData`, `signAndSend`; explicit credential and `confirm: true` |
| `GET /api/wallet-policies`, `GET /api/wallet-policies/:id`, `POST /api/wallet-policies`, `DELETE /api/wallet-policies/:id` | Policy management                                                                              |
| `GET /api/wallet-api-keys`, `POST /api/wallet-api-keys`, `DELETE /api/wallet-api-keys/:id`                                 | Scoped token creation and revocation; tokens returned only at creation                         |

Reference: [OWS Node SDK and native core](https://github.com/open-wallet-standard/core/tree/main/bindings/node), [OWS access profiles](https://docs.openwallet.sh/doc.html?slug=04-agent-access-layer).

## E2B desktop

Browser Use Cloud is also available in the Computer panel as a separate **Browser Use** tab, with recorded browser sessions, cloud agent tasks, follow-ups, and explicit stop controls. See [Browser Use setup](BROWSER-USE.md).

E2B is the default computer provider. Each Dot gets its own desktop sandbox, browser profile, and `/home/user/opendots-workspace` directory. The Computer panel retains Browser, Files, Terminal, Activity, and human takeover controls. Browser, files, and shell permissions start disabled; enable the capabilities you want and choose **Start computer**.

The app uses the official `@e2b/desktop` SDK. Sandbox control and public ports require authentication, and access tokens remain on the server. Public-port Host headers use `localhost:${PORT}` so Chromium's DevTools endpoint accepts the authenticated connection. Shell commands and files run inside the sandbox. Workspace file operations also resolve symlinks before reading or writing, so a relative path cannot escape the workspace.

**Stop computer** pauses the sandbox and preserves its files, browser profile, and processes. **Start computer** resumes that same sandbox. Sandbox IDs persist in SQLite. A sandbox automatically pauses after its configured timeout; status polling does not resume or provision it. Transient failures report **Unavailable** and do not silently replace it. A verified missing sandbox can be recreated by an explicit Start action.

Taking human control blocks agent actions. Releasing control and restarting require a fresh browser snapshot before the agent continues. Browser references are tied to that snapshot and become stale after browser actions. The existing audit records metadata and outcomes, not credentials, typed input, or terminal commands.

Set `COMPUTER_PROVIDER=openbot` to use the original supervisor and computer-token configuration described in [Computer setup](COMPUTERS.md).

Run the live integration verifier with:

```sh
node --env-file=.env --import tsx scripts/verify-e2b.ts
```

It creates a temporary sandbox, tests browser navigation, screenshots, files, terminal execution, takeover, and pause/resume, writes evidence to `artifacts/verification`, and deletes its temporary sandbox afterward. It uses E2B credits.

References: [E2B computer use](https://docs.e2b.dev/use-cases/computer-use), [Pause and resume](https://docs.e2b.dev/sandbox/persistence), [Authenticated public ports](https://docs.e2b.dev/network/restrict-public-access).
