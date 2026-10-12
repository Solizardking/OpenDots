# ChatGPTEE Privacy Policy

Effective date: October 11, 2026. Applies to the ChatGPTEE service at https://chatgptee.ai and its companion application features. A self-hosted deployment is operated by its own administrator; ask that administrator about its hosting, logs and service configuration.

## Who this policy covers

CLAWD operates ChatGPTEE at https://chatgptee.ai and is responsible for the hosted service's account and workspace processing. Your selected model, wallet, authentication, computer and communication providers operate their own services under their own policies. This policy describes the application's actual data flows and controls; provider availability varies with configuration.

For support, security and privacy requests, contact CLAWD at [clawdbot@mail.grokbot.com](mailto:clawdbot@mail.grokbot.com). A self-hosted deployment's administrator is responsible for its own operator details and processing. Do not send a recovery phrase, private key, owner token or provider credential with a privacy request.

## Information processed

| Category                               | Examples and purpose                                                                                                                                                                                                  |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account and sign-in information        | Public Solana address, linked provider identifiers, account profile, authentication challenges and sessions; used to verify access and keep account/workspace mappings                                                |
| Workspace content                      | Dot settings/instructions, conversations, tool results, Spaces/pages, schedules, memories and trading journals; used to retain and perform the work you request                                                       |
| Connected-service information          | MCP endpoints/tokens, selected provider configuration, browser profile/session references and messaging bindings; used to connect the tools you enable                                                                |
| Wallet and transaction information     | Public addresses, encrypted local vault data, explicit signing requests, prepared reviews, signatures and receipts; used for the selected wallet workflow                                                             |
| Connection and operational information | Browser request headers, trusted client IP for authentication/rate limits, session cookies, provider status, bounded activity records and setup telemetry; used for access control, service operation and diagnostics |

Remote webpages, tool responses and market data can contain third-party information. Only provide content and connect accounts you have authority to use.

## Storage and hosted account isolation

Hosted identity, linked-account and session metadata are stored in PostgreSQL. The supplied hosting configuration supports Supabase PostgreSQL; this app does not automatically place workspace files in Supabase Storage.

Each signed-in hosted account has its own persistent SQLite workspace and encrypted OWS vault directory on the server. Dots, pages, conversations, memories, schedules and provider jobs are scoped to that workspace. Private users do not inherit the original owner's Slack mappings, Browser Use profile or supplied CDP connection.

The Mac application keeps its workspace in its local application data directory. Provider credentials use the native encrypted settings mechanism backed by macOS Keychain. Local-first storage describes the location of this workspace; enabled remote services still receive the data required for their requests.

## Authentication, cookies and account linking

Sign In With Solana uses a message proof with a short-lived nonce, domain/URI checks, signature verification and browser binding. A sign-in signature proves wallet ownership; it does not approve a payment or transaction.

Better Auth creates application session cookies. Configured Privy/social sign-in is verified server-side before an account session is issued. Privy access tokens are verified without being stored as application credentials. Direct Better Auth social integrations can store encrypted OAuth tokens as part of linked-account records.

Authentication/session cookies support sign-in, logout, account linking and access controls. Paired phones use a separate limited companion cookie. Native desktop shell access uses the local process's authenticated browser context. Revoking a session or pairing prevents future authorized access; it does not delete the workspace.

Social account linking is explicit and requires a fresh session. Accounts are not automatically merged by matching email. Connecting or switching a transaction wallet does not automatically relink the authenticated account.

## AI and model-provider processing

When you request a model reply, the configured provider receives the prompt, relevant permitted context and tool information needed to respond. The server selects the model configuration; the browser does not receive its private API key.

Optional CopilotKit Intelligence can provide conversation/learning services. OpenRouter batch jobs send their selected prompts to the provider and can retain asynchronous inputs/results under the provider's current contract. Closing a panel does not cancel a queued or running batch or stop its provider charges. This implementation does not offer active batch cancellation; the provider completes, fails or expires the job. Terminal jobs can be deleted through the supported local/provider deletion workflow.

Provider settings, retention and permitted uses are governed by those providers' current terms. Review them before submitting sensitive, personal or third-party confidential content.

## Memory and learning

Mem0 is optional long-term recall. It requires configured credentials, workspace and Dot memory permission, and an unpaused workspace. Relevant scoped facts are retrieved as context; completed conversation turns enter a durable local outbox for extraction. Pending uploads and indexing can persist and retry after restart.

Supermemory supports separately scoped Trading Brain retrieval and journal indexing. Trading journals, paper observations and strategy versions persist locally; indexing progress is distinct from a completed remote index. Optional Intelligence learning containers and skills are another separate data flow.

Disabling a permission prevents subsequent permitted work and cancels active requests where supported. It does not automatically delete material previously accepted by a provider. Deletion and retention at a selected provider must follow its supported controls and policy.

## MCP, research and computer providers

MCP connections store their endpoints and bearer tokens in server-side SQLite. Tokens are excluded from connection descriptors returned to the browser. Tool arguments and the resulting data go to the connected service when a tool actually runs. For reviewed tools, the application saves the exact request and waits for the person's approval.

E2B/OpenBot computers retain their own files and browser profiles. Browser Use Cloud can retain browser sessions, tasks and recordings. A browser profile may contain cookies or authenticated website state. Share a profile only when you intend to make that state available to the selected environment.

The computer audit records action metadata/outcomes and omits typed input, file contents and full terminal commands. The sandbox/browser providers may produce their own records. Closing a panel does not stop a cloud browser; use its explicit stop control.

OpenMarket, public research, xAI X Search and Trading Brain services receive the bounded requests needed to obtain their results. Research data and tool outputs are treated as untrusted context.

## Voice, phone and messaging

Voice calls use the configured realtime provider and can save a transcript and delegated compute result to the selected conversation. The browser requests microphone permission for a call.

A paired phone accesses limited functions of the existing Mac workspace. Pairing requires a short-lived, single-use code and a valid paired-device credential thereafter. Wallet signing and restricted provider controls stay on the Mac.

Optional Slack and Spectrum Telegram/cloud-iMessage integrations receive and send supported message content through their configured services. Account links bind the owner, selected Dot and exact provider identity/space/line. The cloud-iMessage integration does not read the local macOS Messages database. Provider-ready status does not establish that a live message or call has completed.

## Wallets, payments and public blockchains

Connected-wallet signing happens in the chosen compatible wallet. The native OWS path uses an encrypted vault and the local/runtime signer; explicit signing requires a credential and confirmation. Decrypted secrets are not returned to the model or agent, and the signer shares the application runtime's address space.

Privy embedded wallets and external-agent grants use Privy's separate authorization infrastructure. Device grants, wallet policies and an explicit per-request x402 payment review have different roles.

Solana and other supported blockchain transactions can permanently reveal addresses, transaction instructions, amounts and signatures to public networks, explorers and infrastructure providers. An application-side deletion cannot erase a confirmed public blockchain record.

A quote, unsigned review, submitted transaction and independently confirmed chain result are separate states. Creating a wallet or signing in does not fund it or authorize unrelated payments.

## Telemetry, logs and security

The package includes setup and optional SDK usage telemetry. The implemented SDK opt-outs include DO_NOT_TRACK=1 and COPILOTKIT_TELEMETRY_DISABLED=true. Those settings are distinct from operational logs, authentication records and external-provider usage records.

The service uses scoped access checks, origin checks, verified authentication proofs and protected provider credentials. Native credentials and local wallet vaults have their stated encryption mechanisms; this does not imply universal end-to-end encryption, hardware attestation or an enclave guarantee. The ChatGPTEE name is branding.

Operators must protect hosting credentials, databases, volumes and backups. Connected tools and browser providers extend the trust boundary. Report suspected unauthorized access through the [CLAWD support](mailto:clawdbot@mail.grokbot.com) and revoke affected sessions/grants where available.

## Retention and deletion

Workspace content and job/outbox state remain in the persistent runtime until removed through supported controls or the operator's storage administration. Backups and recovery copies may have separate schedules. This source does not impose a universal automatic purge interval.

You can use available page, memory, wallet/key and connection controls to remove or revoke supported records. Detached-wallet deletion requires confirmation. Sign-out revokes account sessions; it does not erase pages, chats, schedules, provider records or public-chain activity.

For comprehensive account export, correction or deletion, contact the operator of the deployment. The operator may verify account control and must address applicable retention duties, existing backups and provider processing. Avoid deleting a local vault without preserving the recovery material you need.

## Your choices and applicable rights

Choose which Dots, Spaces, research tools, memory, computer capabilities and providers to enable. Review external writes, wallet proposals and API payments through their dedicated controls. Revoke sessions, companion devices, connections, scoped keys and external-agent grants when no longer needed.

Where applicable law grants access, correction, deletion, portability, restriction, objection or complaint rights, you may exercise them through the relevant operator/provider. The available right, response deadline and lawful exceptions depend on your jurisdiction and the processing involved.

The operator's purposes include providing requested services, authenticating users, maintaining security, managing enabled connections and resolving service requests. Where law requires an additional legal basis or consent, the operator must establish it for the deployment and feature concerned.

## Children and policy changes

This service is intended for users able to enter the applicable service agreement and lawfully use its connected providers and wallet features. The operator should not knowingly collect a child's personal information without the legally required permissions and safeguards. Report an account or submission involving a child through the [CLAWD support](mailto:clawdbot@mail.grokbot.com).

Material changes to this policy should be announced through the service and reflected in the effective date. An updated notice does not silently grant a new tool permission or wallet authorization.

Related pages: [service description](https://chatgptee.ai/service), [terms](https://chatgptee.ai/terms), [documentation](https://chatgptee.ai/docs).
