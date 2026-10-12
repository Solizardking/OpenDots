# Solana Dots

**An AI workspace for Solana, built on top of the new Pump.fun.**

Solana Dots brings persistent AI agents, working documents, agent computers, wallets, and on-chain actions into one workspace. You can research an idea, develop its identity, organize a launch, and prepare a transaction through the same conversation. Each agent has a role and a set of permissions, while every launch or trade remains subject to your approval.

The macOS app gives that workspace a home on your computer. Conversations continue across sessions, documents stay organized in Spaces, and a Dot can work with the tools you choose to connect. With Pump.fun integrated into the workspace, creating a coin and trading it become part of the conversation surrounding the project.

A Dot is a specialist you configure for a particular job. Give it a name, instructions, an avatar, access to relevant Spaces, and permission to use selected tools. One Dot can investigate a topic, another can write launch materials, and another can help inspect tokens and prepare transactions. Persistent conversation history keeps their work available when you return. Optional memory integration lets permitted Dots recall information across conversations.

Spaces hold the documents behind that work. Research notes, launch briefs, descriptions, plans, and project updates can become editable pages with formatting and nested subpages. You can write directly, save a conversation as a page, or ask a Dot to revise a document it has permission to access. An idea discussed in chat can develop into a project with a useful written record.

For tasks that need a browser or working environment, a Dot can use a configured computer service. The computer panel brings browser activity, files, terminal output, and human takeover controls alongside the conversation. Permissions determine which actions the Dot can perform. Connected services extend those capabilities with research, external tools, and live calls, depending on your provider setup.

The on-chain layer is built on top of the new Pump.fun protocol interfaces using the official Pump and PumpSwap SDKs. Solana Dots integrates the current coin-creation flow, V3 bonding-curve trades, and V2 PumpSwap trades, with compatibility handling for supported older tokens and existing cashback coins. These interfaces are documented in Pump.fun's official [coin-creation](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md), [V3 trading](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/TRADE_V3.md), and [PumpSwap V2](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/PUMP_SWAP_TRADE_V2.md) references.

Launching starts with the coin's name, symbol, and a public metadata JSON link containing its description and image. The launch flow creates a standard SOL-paired Token-2022 coin using the selected signing wallet as payer and creator. You can include an initial SOL buy in the same transaction, so creation and the initial purchase succeed or fail together. An optional holder-rewards setting directs creator fees to holders; that choice is permanent under the [Pump.fun creation interface](https://github.com/pump-fun/pump-public-docs/blob/main/docs/instructions/COIN_CREATION.md).

You can prepare the launch through the Pump.fun panel or ask a Dot in chat: "Prepare a launch for Example, symbol EX, using this metadata link, with a 0.01 SOL initial buy." The panel also provides direct launch and trading controls without requiring a model provider. The chat route adds an agent that can help organize the inputs and explain the resulting proposal.

Trading follows the same conversational approach. Ask a Dot to inspect a mint, prepare a buy with a specified budget, or prepare a sale of a specified token amount. For example: "Inspect this Pump.fun mint," followed by "Prepare a buy of 0.01 SOL with 1% slippage." Inspection reads the token's on-chain information, identifies its quote asset and trading venue, and checks the selected wallet's token balance.

The app prepares supported trades against the bonding curve or the canonical PumpSwap pool after migration. Buy amounts use the coin's quote asset; sell amounts use token units. The integration reads the actual token decimals and fee configuration, then applies the requested slippage limits. The review presents the maximum spend and minimum receive so you can assess the proposed trade before signing.

Wallet choice remains explicit. You can connect a compatible Solana wallet and review the transaction in that wallet, or use an encrypted local wallet assigned to a Dot in the Mac app. Connecting a wallet authorizes the app to identify the signing account. Each transaction still requires its own approval. Creating a local wallet also requires funding it before it can pay transaction fees, account rent, or a purchase.

The transaction review card shows the signing wallet, mint, quote asset, amounts, fees, estimated SOL debit, and proposal expiry. It loads the transaction stored by the server and binds approval to that exact proposal. Changing important inputs requires fresh preparation. For local Dot wallets, the signing credential goes directly to the wallet signer and is cleared from the form; it is excluded from model messages and transaction records. Wallet private keys are never exported to the agent.

After submission, the receipt distinguishes a submitted transaction from one confirmed on-chain. The app checks the signature for confirmation and provides an explorer link. Expired or declined proposals require a new review, and duplicate approval does not trigger another signing or broadcast. If the network response leaves submission uncertain, the app retains that state while checking the signature.

The wider workspace can grow with your setup. Choose a supported chat provider, connect research and computer services, and add tools through MCP connections. Permissions apply to individual Dots, letting you configure a researcher differently from an agent that prepares transactions. Optional voice calls offer another way to work with a Dot while longer tasks continue.

In the Mac edition, workspace data is stored locally and provider credentials use macOS Keychain-backed encryption. Model requests and connected tools use their configured external services, so their availability and data handling remain part of your provider choice. A paired phone browser can continue conversations and edit Space pages on the same trusted local network; wallet signing and provider settings stay on the Mac.

To begin, create a Dot, give it access to a project Space, and choose the wallet you want to use. Develop the launch brief, prepare the metadata, and open Pump.fun from the workspace or conversation. Your agent can help turn those inputs into a proposal. You review the transaction, approve it with your wallet, and follow its on-chain receipt from the same workspace.
