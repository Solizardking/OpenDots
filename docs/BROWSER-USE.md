# Browser Use Cloud

Open the Computer panel with the monitor button, select a Dot, and choose **Browser Use**. Enable **Allow Browser Use** for that Dot. Browser Use is separate from the E2B desktop and is available without a CopilotKit conversation credential.

The server reads these values from the ignored `.env` file:

```dotenv
BROWSERUSE_API_KEY=
CLAWD_PROFILE=
CDP_URL=
BROWSER_USE_WORKSPACE_ID=
BROWSER_USE_MODEL=gpt-6-luna
```

`BROWSER_USE_API_KEY` is accepted as an alias; a non-empty `BROWSERUSE_API_KEY` takes precedence. In the existing owner workspace, `CLAWD_PROFILE` is passed as `profileId` to standalone browsers and task browsers, and the configured file workspace is shared by its Dots. Wallet accounts receive a separate cloud file workspace on their first task; that namespace persists across their Dots, sessions, and restarts. They do not inherit the owner's browser profile or supplied CDP connection. Cloud browser and run IDs remain scoped to each Dot. Keep provider credentials and the CDP connection on the server. Restart the app after changing `.env`.

**Start cloud browser** creates a standalone browser with a Japan proxy, a 15-minute timeout, resizing enabled, and recording enabled. Its live view appears in the panel. **Stop cloud browser** explicitly stops the provider session. Closing the panel or disconnecting a CDP client does not stop billing.

**Run browser task** requires a non-empty task. Runs use `gpt-6-luna`, high reasoning effort, the default service tier, the account's workspace, `judge: {}`, and a recorded US-proxy browser at 1440 × 900. **Continue the previous task session** reuses that Dot's previous session. Wallet accounts must start a new task before continuing an older session that used the shared file workspace. The hosted agent provisions its own browser; a standalone browser and `CDP_URL` are separate connections. The production run API does not accept an external CDP attachment.

**Stop task** cancels an unfinished run and stops its cloud browser. **Stop all cloud work** also stops the standalone browser. Disabling permission, pausing ChatGPTEE, and normal server shutdown stop owned cloud work. The server persists session ownership in SQLite so a restart does not lose the controls. Provider failures are shown as failures, with credentials and internal error payloads excluded from the UI.

Recordings are stitched after a browser stops. Refresh until a download appears; polling ends when `recordingAvailable` is false, with automatic recording polling bounded to two minutes. The SDK's v4 resource supports browser creation and stopping but currently omits `browsers.get`, so inspection uses the official v4 REST endpoint.

**Check supplied browser** checks `CDP_URL` through `/json/version`. It does not navigate or stop that pre-existing browser. An expired endpoint is shown as unavailable.

Dots receive `browser_use_task` and `browser_use_status` tools when the key is configured. An agent task requires this Dot's Browser Use permission. Its wait is bounded, unfinished runs are cancelled on interruption or timeout, and its browser is explicitly stopped in `finally`. Conversations use local SQLite history when the optional CopilotKit Intelligence credential is absent.

Run the live verifier with:

```sh
node --env-file=.env --import tsx scripts/verify-browser-use.ts
```

The verifier uses provider credits, checks the supplied CDP endpoint, navigates a temporary standalone browser, downloads its recording, and tries an agent task and follow-up. It saves redacted evidence in `artifacts/verification` and stops its owned resources in `finally`. A model-provider failure produces an unsuccessful evidence report and exit status 1.

References: [Browser Use v4 API](https://docs.browser-use.com/cloud/api-v4), [official SDK](https://github.com/browser-use/sdk).
