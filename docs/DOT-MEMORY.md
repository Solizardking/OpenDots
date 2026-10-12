# Persistent Dot memory

Each Dot keeps its identity, settings, Spaces, and conversation bindings in its
workspace SQLite database. Without CopilotKit Intelligence, chat messages, tool
results, and state also stay in that database. Mem0 adds long-term recall across
new conversations with the same Dot; it does not replace conversation storage.

Set these **server-only** values in `.env`, then restart the server:

```dotenv
MEM0_API_KEY=
MEM0_BASE_URL=https://api.mem0.ai
MEM0_ORG_ID=
MEM0_PROJECT_ID=
```

Docker Compose forwards those values and stores the database on `opendots-data`.
Preserve that volume, `DATABASE_PATH`, `USER_DATA_PATH`, and `OWNER_ID` across
restarts. Signed-in users keep separate workspace databases under
`USER_DATA_PATH/<user-id>/workspace.sqlite`. The web entry point additionally
requires the existing Neon/Postgres `DATABASE_URL` for user authentication.

Desktop Settings includes a Mem0 connection and organization/project fields.
The desktop key is encrypted with macOS Keychain alongside the other provider
keys, then passed to the local server over IPC. Keys are never bundled into the
app or returned in memory status responses.

Before generating a reply, the server retrieves up to eight relevant memories
using identities derived from the authenticated workspace owner and Dot ID. It sends
the specified organization and project on every provider request. Dot agent IDs
also contain the owner ID, isolating agent-attributed memories between users.
Mem0 V3 attributes user and assistant facts separately, so recall searches either
of those exact scoped identities instead of requiring both on the same fact.
Retrieved memories are untrusted context in the existing model prompt.

After successful streaming completion, the latest user message and assistant
reply enter a durable SQLite outbox. The server uploads that turn to Mem0 for
fact extraction, rather than repeatedly uploading the whole chat. A pending
provider event stays pending until its event status confirms success. Failed
uploads and extraction jobs retry with backoff; restarts retain pending work.
This is at-least-once delivery: a crash after provider acceptance but before the
event ID is saved can resubmit a turn. Completed run IDs prevent ordinary duplicate
uploads. Historical conversations are not automatically backfilled.

Global and per-Dot memory permissions govern recall, uploads, and queued retries.
Disabling memory cancels in-flight memory requests and leaves queued turns local;
enabling it resumes them. Existing remote memories remain in Mem0. These controls
do not erase conversation history or provider data. Pause also suspends memory
requests. Provider outages keep chat usable with relevant cached memories, and
the UI reports the failure. Cached facts are bounded to 100 per Dot.

The **Memories** view shows each Dot's confirmed turn count, pending uploads,
recently recalled facts, and errors, alongside the existing shared preferences.
`GET /api/dots/:id/memory` exposes that status inside the existing authenticated
workspace boundary. Tool arguments, tool results, and source-page contents are
not automatically uploaded to Mem0. Text explicitly included in user/assistant
messages can be sent; extraction instructions exclude credentials, but users
should avoid putting secrets in chats.

Verify locally with:

```sh
npm test -- tests/dot-memory.test.ts tests/local-conversations.test.ts
npm run typecheck
npm run build
```

For a live Mem0 and configured-model check:

```sh
node --env-file=.env --import tsx scripts/verify-dot-memory.ts
```

That script creates an isolated temporary workspace, sends two model turns,
restarts while Mem0 processing is pending, verifies recall in a new conversation
and Dot isolation, writes `artifacts/dot-memory-verification.json`, and deletes
its synthetic remote memories. It does not exercise web sign-in or deploy the app.
Pass `--mem0-only` to verify real Mem0 persistence, extraction, and isolation with
synthetic messages when the chat provider is unavailable. This mode reports that
live model responses and the normal chat API were not exercised.

The implementation follows the official [Mem0 add API](https://docs.mem0.ai/api-reference/memory/add-memories)
and [Mem0 search API](https://docs.mem0.ai/api-reference/memory/search-memories)
using native server-side fetch with cancellation and timeouts.
