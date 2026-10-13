# Supermemory in OpenDots

OpenDots uses Supermemory in two independent ways: server-managed private trading memory and an OAuth MCP connection selected by each user. Configuring one does not authorize the other.

## Server-managed memory

Set `SUPERMEMORY_API_KEY` on the ChatGPTEE Railway service in the production environment. It is a server credential, never a browser variable or an MCP bearer token. The private trading outbox works with this key alone; TypeSafe is required only for typed decisions and monitoring.

Saved strategy and journal records use the v5 namespace routes at `https://api.supermemory.ai/ns/<namespace>/document` and `/search`. The server derives the namespace from the workspace owner and Dot identity; clients cannot select another owner's namespace. Stable document IDs prevent retries from creating duplicate records. Supporting context identifies the private journal and distinguishes observed paper outcomes from executed trades.

An accepted document remains queued locally. Supermemory processes documents through `unknown`, `queued`, `extracting`, `chunking`, `embedding`, `indexing`, `done`, or `failed`. OpenDots marks a journal record indexed only after a document read confirms both `system.status` and `system.dreamingStatus` are `done`. Dynamic memory generation can finish after document search becomes available. Provider failures remain visible and retry with the same document ID.

Memory and research permissions are enforced for every workspace and Dot. Mem0 conversation memory remains independent. Enabling Supermemory does not copy historical conversations, overwrite organization-wide context, or authorize transactions.

## Connect your Supermemory account

1. Sign in to ChatGPTEE and open **Edit specialist → Connections**.
2. Select **Connect Supermemory**. The application uses the fixed remote server `https://mcp.supermemory.ai/mcp`.
3. Sign in at Supermemory and approve the spaces you want this connection to access.
4. Return to ChatGPTEE. The callback completes the connection, discovers its tools, and keeps credentials on the server.

No API key or custom header is needed for this MCP connection. Authorization uses PKCE and an expiring, one-use state bound to the current workspace and Dot. OAuth credentials are encrypted in that user's workspace database, with a private key on the persistent data volume. Reconnect from Connections if authorization expires or the callback is lost.

Each discovered tool retains the existing per-Dot **Enabled** and **Ask first** controls. Read-only tools can run directly; changes require the user's approval. Removing a connection removes its saved credentials and pending authorization from OpenDots.

## Choose spaces

The connection's space list contains only spaces permitted by Supermemory. Select a space and explicitly apply the active-space change when future requests should use it. This changes the Supermemory account's active space and can affect its other connected clients.

For a one-off action, name the space in the request. Resolve it through `list_spaces`, then use the returned namespace for that tool call: `containerTag` for search/profile/document and memory listing tools, or `namespace` for save/forget tools. A one-off request does not change the active space. Omitting a space uses Supermemory's active space or account default.

Useful requests include “What Supermemory spaces can I access?”, “What is my active Supermemory space?”, and “Search my saved context for the launch plan.” Successful discovery and an authorization handoff do not prove completed consent; the connection becomes usable after the account owner returns through the callback.

OpenDots provides native connection and space controls. Supermemory's upload, guided-save, and memory-graph widgets require an MCP Apps-compatible client; this connection does not render those widgets or import every resource/prompt automatically.

## References

- [Complete Supermemory documentation index](https://supermemory.ai/docs/llms.txt)
- [MCP setup and usage](https://supermemory.ai/docs/supermemory-mcp/setup)
- [MCP tools and spaces](https://supermemory.ai/docs/supermemory-mcp/mcp)
- [API keys and authentication](https://supermemory.ai/docs/authentication)
- [v5 document status and reads](https://supermemory.ai/docs/migration/api-v5-document-reads)
- [Ingestion and processing modes](https://supermemory.ai/docs/ingestion/add-memories)
