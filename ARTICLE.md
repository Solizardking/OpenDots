# ChatGPTEE: a workspace where agents can follow through

A conversation with AI can produce a useful answer. A project needs more: documents that keep changing, context that survives tomorrow, tools that can act, and a clear record of what the person actually approved. ChatGPTEE brings those pieces together in one personal agent workspace.

Built as a Solana-focused adaptation of CopilotKit's OpenDots, the product combines persistent specialists called Dots, editable Spaces, computer environments, connected services and reviewed wallet workflows. Its innovation is the continuity between those surfaces. A research question can become a working page, a plan, an external tool request or a transaction proposal without discarding the context that gave the work meaning.

The implementation is ambitious, but the useful claims are concrete. It has saved conversations and pages, explicit permission checks, scoped account storage, sandbox controls, source-backed market analysis and immutable transaction reviews. Optional providers still require configuration and successful live verification. An integrated button is an entry point, not evidence that a remote service or trade has succeeded.

## An agent has a role, a place and a history

A Dot is more than a name at the top of a chat. It has instructions, an avatar, access to chosen Spaces, research and memory preferences, computer capabilities, connected tools and, where appropriate, wallet context. A writer and a researcher can therefore share a project while operating with different access.

That makes delegation easier to understand. The user can describe what a specialist should do and select what it may use. The backend checks those settings when tools run; permissions do not depend only on the model following an instruction. Workspace pause and capability revocation have a practical meaning across active work.

Persistent conversation storage also changes the experience. Without optional CopilotKit Intelligence, messages, tool results and state live in the runtime's SQLite workspace. Hosted users keep private per-user databases on the server; the Mac edition stores its workspace locally. A person returning to a Dot can recover the work that actually happened.

A configured model provider still receives the model requests. Local storage does not turn remote inference into device-only processing. The distinction helps the user understand both the benefit and the boundary.

## Documents become part of the working conversation

Spaces give a project durable written context. Pages support rich editing, nested subpages, headings, lists, checklists, tables and an outline. Autosave and saved-state feedback connect the writing experience to persistent storage.

The page conversation puts the document beside the discussion. An agent can help explain an argument, find missing evidence or propose a revision with the current page as context. Turning a chat into a page uses a reviewed draft and a selected Space, with a receipt bound to that conversation and tool call.

This is a useful product choice because an answer is often only the beginning. The final launch brief, decision note or plan should remain editable and legible after the chat scrolls away. ChatGPTEE gives the conversation an artifact that can become the project's next source of truth.

Space permissions also carry into the agent tools. A Dot's ability to discuss or create a page is checked against the Space it is allowed to access. The application can keep private project context separate even when several specialists are available.

## A computer belongs to the specialist

Some tasks need a browser, files or a terminal. ChatGPTEE places those tools in a Dot's configured environment and exposes them alongside the conversation.

E2B provides the default desktop sandbox. OpenBot offers a Docker supervisor alternative. Browser, file and shell capabilities begin disabled and can be enabled independently. A saved sandbox or container workspace retains files and browser profile through supported pause/start behavior.

Human takeover is especially valuable. Taking control blocks agent input; handing control back requires a fresh browser snapshot before element actions continue. A person can intervene without pretending that the agent's old view of the page is still accurate.

Browser Use Cloud adds a separate path for hosted browser tasks, live views, follow-ups and recordings. Private accounts receive an isolated persistent file namespace instead of inheriting the original owner's browser profile. Explicit stop controls matter because closing a panel does not end a paid cloud browser.

These providers have different infrastructure and trust properties. OpenBot uses normal container isolation by default; E2B and Browser Use rely on their services. The product does not silently run shell commands on the user's machine when a remote computer is unavailable.

## Connected tools preserve the person's decision

MCP connections let a Dot reach services beyond the built-in workspace. A connection lists the remote server's tools, and the user can enable each tool and decide whether it should ask first.

For a reviewed action, the server saves the exact tool, connection and arguments before showing the approval card. The approval executes that stored request once, subject to the Dot's current tool settings and expiry. A replacement argument supplied during approval cannot quietly change what the person reviewed.

A read-only hint can allow unattended reads, but the hint comes from the remote tool server. The user can still require approval. Scheduled turns and Slack do not invent an approval channel; tools that need review ask the person to return to the web app.

The innovation here is practical accountability. An agent's proposed action, the person's choice and the saved result remain connected. That is more useful than a vague global setting that makes every future action equally authorized.

## Solana becomes a reviewed workflow

The Solana workspace brings Pump.fun launches and trades, Jupiter swaps, DFlow indicative quotes and wallet context into the same place as research and project documents.

A launch can start with a name, symbol, metadata link and optional initial purchase. A trade can begin with an exact mint, amount and slippage. The integration uses official Pump and PumpSwap SDKs and reads relevant token, fee and venue information from the actual chain state.

The agent can help organize those inputs and explain a proposal. The user still reviews the wallet, exact message, amounts, fees, simulation and expiry before approving the transaction in the selected wallet. Changing the input or wallet requires a fresh preparation. The backend verifies that the submitted signature matches the stored review.

Jupiter follows the same pattern with managed Order and advanced Build routes. DFlow cards provide indicative spot comparisons and do not execute their own prediction-market transactions. A quote, an unsigned review, a submission receipt and independent chain confirmation are distinct states.

That separation is central to the product's credibility. ChatGPTEE can integrate preparation without presenting an AI suggestion as a funded or executed trade. The workflow gives the person a useful place to reason before a consequential signature.

Wallet types are also explicit. A connected browser wallet signs through the user's wallet interface. The native OWS path stores encrypted local Dot wallets and requires an explicit signing credential; the signer shares the local application's address space. The hosted Pump workflow uses a connected browser wallet, while the Mac runtime enables local-wallet Pump signing. Generic OWS signing routes require an authenticated workspace, an explicit credential and confirmation in the runtime holding the encrypted vault. Privy embedded wallets support their own user-granted external-agent path. These are different control models, not interchangeable claims of custody.

## Research gains a journal

OpenMarket adds crypto and Polymarket datasets to the workspace. Its panels and read-only Dot tool support instrument discovery, candles, orderbooks, derivatives indicators and trader/market analytics. Request bounds and observation times make large datasets manageable, while provider entitlement and quota failures stay visible.

The Trading Brain goes further by connecting a Dot's saved strategy to evidence, decisions and later observations. SQLite retains strategy versions and a journal. Optional Supermemory supports scoped retrieval, and TypeSafe evaluates constrained action, risk, strategy and evidence questions.

Monitoring is an explicit, bounded choice. Eligible decisions need fresh priced evidence and the saved thresholds. A review request can prepare through the existing Pump flow, but the brain never automatically trades.

Later paper outcomes use observed prices and exclude execution, fees and slippage. Repeated observed losses can raise the confidence threshold. That is policy adaptation based on recorded observations, not model training or realized profit.

The interesting idea is a memory of the reasoning itself. A user can ask what changed, which source supported a decision and whether a current strategy still matches the evidence. The journal helps keep the agent's analysis inspectable over time.

## Memory, communication and reach

Mem0 supplies optional long-term recall across conversations for a scoped Dot. Completed turns enter a durable local outbox, with retryable extraction and status checks. Local history remains separate from extracted facts, and a pending upload is separate from a completed remote index.

Calls offer realtime voice and delegate longer compute work into the same conversation. Phone pairing can expose selected companion controls while provider settings and signing stay on the Mac. Optional Slack and Spectrum Telegram/cloud-iMessage integrations extend communication with their own account bindings, activation requirements and provider configuration.

External agents have another explicit boundary. A Privy device flow lets the account owner inspect and grant scoped wallet access. The CLI uses operating-system credential storage, and the user can revoke the grant. This authorization is separate from opening the workspace.

Bounded x402 requests can pay supported API offers with USDC after review. The interface checks the offer's network, token, amount, recipient and resource and caps a request at no more than 1 USDC. Wallet funding, agent authorization and settled payment are separate facts. That makes paid data access an inspectable action rather than an invisible side effect of asking a question.

## Innovation that can be assessed

Many of ChatGPTEE's components are established tools: React, Hono, SQLite, PostgreSQL, Tiptap, MCP, model APIs, sandbox providers and Solana SDKs. The product's originality lies in how their state and permissions are connected.

The same specialist can retain its role across chat, a page discussion, scheduled work and permitted tools. A document can become usable context instead of an exported dead end. A computer can be paused for human intervention. A wallet proposal can preserve the exact relationship between intent, review, signature and receipt. A strategy can accumulate evidence without becoming an automatic trader.

There are meaningful limits. Provider keys, account entitlements, live callback configuration, persistent hosting volumes and network reachability determine which features work in a given installation. Computers and remote models consume provider resources. External services have their own data handling. Public documentation and fixture tests explain and validate local behavior; they do not certify every live integration.

The name ChatGPTEE does not establish that this checkout runs inference or wallet signing inside an attested trusted execution environment. No universal enclave or confidential-computing guarantee follows from the brand.

A complete workspace should make those distinctions easy to see. ChatGPTEE's strongest idea is that a capable agent and an accountable interface can grow together: preserve context, make proposals useful, keep permission specific, and leave a record the person can inspect. That gives an AI assistant a practical path from a conversation to work someone can actually trust and continue.

---

Implementation companion: [public documentation](https://chatgptee.ai/docs), [download the guide](/docs/GUIDE.md), [external agent setup](/agent/SKILL.md).

This article describes the code and workflows in this checkout. It does not report a production deployment, completed social login, funded trade or paid API request.
