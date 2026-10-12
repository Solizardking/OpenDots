# Spectrum messaging transport

This integration uses **Photon Stable**, with pinned `@spectrum-ts/core`, `@spectrum-ts/imessage` and `@spectrum-ts/telegram` **12.10.1**. The installed Stable CLI is `@photon-ai/cli`; Beta `photon-cli`, bearer credentials and `https://api.photon.codes/v1` are separate contracts. See the [Stable skill](https://photon.codes/docs/skill.md), [SDK quickstart](https://photon.codes/docs/spectrum-ts/getting-started.md) and [Telegram setup](https://photon.codes/docs/spectrum-ts/providers/telegram/setup.md).

Create a **new ChatGPTEE Spectrum project** and **new Telegram bot**. Enter the new project secret, bot token and webhook verification secret privately in **Railway → OpenDots service → Variables**. Keep them in encrypted server variables; do not enter secrets in the website, chat, source files or browser build variables. Reusing an existing project would subscribe to its existing conversations; reusing an existing Telegram bot could redirect its webhook. This adapter does not transfer or reuse the separate clawd bot/project credentials.

The server configuration defaults to off. Add the following values privately, then enable the providers you intend to use:

```dotenv
SPECTRUM_MESSAGING_ENABLED=false
SPECTRUM_PROJECT_ID=
SPECTRUM_PROJECT_SECRET=

SPECTRUM_TELEGRAM_BOT_TOKEN=
SPECTRUM_TELEGRAM_BOT_USERNAME=
SPECTRUM_TELEGRAM_BOT_ID=
SPECTRUM_TELEGRAM_WEBHOOK_SECRET=
SPECTRUM_TELEGRAM_REGISTRATION_APPROVED=false

SPECTRUM_IMESSAGE_ENABLED=false
SPECTRUM_IMESSAGE_LINE_MODE=dedicated
SPECTRUM_IMESSAGE_PHONE=
SPECTRUM_IMESSAGE_LINE_OWNERSHIP_CONFIRMED=false
```

`SPECTRUM_TELEGRAM_BOT_ID` is optional; the username is checked against `getMe` when supplied. Use a long, random Telegram webhook secret containing only letters, numbers, underscores and hyphens (16–256 characters). Set `SPECTRUM_TELEGRAM_REGISTRATION_APPROVED=true` only for the new bot whose webhook this server is authorized to register. The SDK automatically registers `https://<project-slug>.spctrm.dev/telegram` during startup. The adapter first checks bot identity and refuses an existing webhook at a different URL. Keep the same verification secret on restarts: the SDK does not reapply a changed secret when the webhook URL already matches. Secret rotation requires a deliberate provider reconfiguration.

For cloud iMessage, enable iMessage in the new project and confirm its [line allocation](https://photon.codes/docs/spectrum-ts/providers/imessage/connection-and-routing). For a dedicated line, enter its exact E.164 number and set `SPECTRUM_IMESSAGE_LINE_OWNERSHIP_CONFIRMED=true`. The server verifies that the number belongs to the project and pins every outgoing reply to the received conversation’s line. It never randomly creates a conversation or substitutes the voice phone. Shared mode uses `SPECTRUM_IMESSAGE_LINE_MODE=shared`; its routing identity is the literal `shared`, and the sender number can vary by recipient. The SDK cannot promise a fixed shared sender number. This self-service website linking flow requires a verified E.164 destination, so shared mode cannot create a new account link without one. Use a dedicated verified destination for the normal ChatGPTEE linking flow; the default is dedicated.

`+12564726195` is the requested **voice call** number. The phone button opens the device dialer with a `tel:` link; this does not prove an AI is answering that phone line. It is not asserted to be a provisioned Spectrum iMessage line. The transport imports only cloud iMessage and does not install or read the local macOS Messages database adapter.

The adapter uses one global provider connection. Its inbound callback provides only normalized direct text messages, public sender and space IDs, a message ID and the routing line. Outbound echoes, groups, reactions, attachments, unrecognized lines and duplicate stream receipts are ignored. The application coordinator owns persistent deduplication, one-use linking, private account/workspace bindings, per-account agent queues and unlink authorization. Replies are sent only to the exact space supplied by that authorized coordinator. Transport sends are plain text with a 4,000-character limit and no automatic retry after an uncertain send.

Current Stable metadata preflight uses authenticated scoped HTTPS GET requests with Basic authentication for project, platform and line information. The current project response can omit `id`; an explicit mismatched ID is rejected. SDK token issuance/renewal remains authenticated. The SDK’s optional background platform-discovery request can return unauthorized without affecting provider initialization; the adapter does not use it to determine availability.

The host calls `start()` after trusted provider activation and calls `stop()` from its existing shutdown lifecycle. Spectrum 12.10.1 installs no process signal handler or forced exit; see [lifecycle guidance](https://photon.codes/docs/spectrum-ts/custom-events-and-lifecycle). SDK telemetry is disabled and provider errors are redacted before status or application logs. Missing credentials, inactive flags and unverified lines remain visibly unavailable.

Transport tests use fixture credentials, mocked provider metadata, SDK initialization and message streams. They do not call phones, send texts, create projects, register bots or access personal iMessage data. Provider readiness and account-link controls are separate from a verified live incoming message and reply.

Authenticated website routes are `GET /api/messaging/status`, `POST /api/messaging/link` with `{platform,dotId}`, and `POST /api/messaging/unlink` with `{platform}`. A link code expires after **10 minutes**, is single-use and must arrive in a direct message from the identity being linked. Routing remains scoped to the signed-in website account, chosen Dot and exact provider identity/space/line. Changing the project, Telegram bot or iMessage line configuration requires a fresh account link. Do wallet reviews and wallet signing in the website; messaging is not a wallet approval channel. No raw provider webhook route is exposed by OpenDots.
