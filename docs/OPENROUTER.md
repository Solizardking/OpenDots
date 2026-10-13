# Muse Wonder and Claude batches on OpenRouter

Set `OPENROUTER_API_KEY` only in the server environment. Production credentials are stored on Railway; never use a `VITE_` variable for this key.

Muse Wonder (`meta/muse-wonder`) is the shared default for all users' Dots, including scheduled and page conversation turns. The server uses its configured key for each user's conversation while histories remain in their separate workspaces. In the Mac app, select **OpenRouter** in **Settings & setup** and save the key there; the native settings encrypt it with macOS Keychain.

For live chat and every Dot’s existing tools, set:

```dotenv
MODEL_PROVIDER=openrouter
OPENROUTER_MUSEMODEL=meta/muse-wonder
OPENROUTER_CLAUDE_MODEL=anthropic/claude-haiku-5.5
OPENROUTER_API_KEY=your-server-key
```

The server uses `https://openrouter.ai/api/v1` with the existing OpenAI-compatible streaming adapter. It trims live-model values and selects the first non-empty setting: `OPENROUTER_MUSEMODEL`, then the legacy `OPENROUTER_MODEL`, then `meta/muse-wonder`. To keep an existing legacy override, leave `OPENROUTER_MUSEMODEL` empty. `OPENROUTER_CLAUDE_MODEL` configures batch jobs only and never selects the live model. A `:batch` model cannot power interactive chat; the server rejects that configuration rather than silently selecting another model. Explicit `MODEL_PROVIDER=xai` and `MODEL_PROVIDER=openai` alternatives remain available with their own credentials.

Open **Claude batches** in the workspace sidebar to submit up to 50 prompts, separated by blank lines. Jobs use OpenRouter’s asynchronous Batch API, a 24-hour completion window, and inlined results. Closing the panel leaves the provider job running; reopening loads its saved history and resumes polling. OpenRouter retains inputs and results for 30 days.

The Batch API uses the base model slug, such as `anthropic/claude-haiku-5.5`, and selects its batch endpoint. `OPENROUTER_CLAUDE_MODEL=anthropic/claude-haiku-5.5:batch` is supported for batch-only use; live chat keeps its separate Muse or legacy model selection.

Authenticated APIs are mounted at `/api/openrouter/batches`. Local job IDs and provider IDs are mapped inside each user’s persistent workspace database. Listing never proxies the account-wide OpenRouter list; polling requires a locally owned job. Repeated submission with the same request ID does not send another paid provider request. Unknown submission outcomes are recorded for review rather than retried automatically. Results are displayed as text and never execute tools or wallet actions.

Verify live chat and Mem0 recall across a restart with `node --env-file=.env --import tsx scripts/verify-dot-memory.ts`. It uses a temporary workspace and removes its synthetic Mem0 records afterward.

For an isolated Mac settings and composer check, run `npm run build`, then `DOTS_ARTIFACT_DIRECTORY=artifacts/openrouter-desktop-verification node scripts/build-desktop.mjs` and `node --env-file=.env scripts/verify-openrouter-desktop.mjs`. This verifies native key encryption, a real configured-model reply, and conversation persistence after restarting the local runtime. The temporary profile is removed afterward. Both checks make real provider requests; reports and screenshots stay in the ignored `artifacts` directory.

References: [Muse Wonder](https://openrouter.ai/meta/muse-wonder), [OpenRouter batch quickstart](https://openrouter.ai/docs/guides/guides/batch-quickstart), [Claude Haiku 5.5](https://openrouter.ai/anthropic/claude-haiku-5.5).
