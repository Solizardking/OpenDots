# Solana Dots 0.2.0 macOS release candidate

The signed Apple Silicon app is installed at `/Applications/Solana Dots.app` and launches normally. Its frozen source is `artifacts/solana-dots/source-2026-10-10T18-01-39-866Z`. The new icon, dark/light appearance, settings and agent drawers, computer panel, Spaces, opt-in mobile browser companion, OpenRouter provider setup, and Mem0 memory controls are included.

Release page: <https://app.clawdbot.party/solana-dots>. The canonical service matches this candidate and verifies its privately stored archive. Public downloads remain disabled because Apple notarization has not been submitted. Existing Clawd Bot edition claims, wallet authentication, and activation continue to use their original release.

The archive is `artifacts/solana-dots/release/Solana-Dots-0.2.0-macOS-arm64.zip`, SHA-256 `2845213e8bef93f5ab55506c5fee98148cbd3e2d4fdccd3cc399a1dbbb441cb3`, 161774953 bytes. The input hash is `ed4f0bccf4a4d6539f26c3395ab5d4397fc729be4f27d82f25c9b33b21791dc2`. The app has a valid Developer ID signature, hardened runtime, and Apple timestamp, with team `MU4489QPHP`. It requires Apple Silicon and macOS 13 or later.

Verification passed: 428 tests (8 skipped), TypeScript, ESLint, 9 download service tests, 39 canonical CLAWD brand assets, signed app launch, installed app launch, native drawer interactions, a real LAN listener with a separate mobile browser, mobile and Mac live OpenRouter replies, shared conversation history, single-use pairing, denied key/settings/signing requests, revocation, and listener shutdown. Release pages fit desktop and 390px mobile layouts without browser errors. No physical phone hardware test or cloud computer/voice session was performed. The bundle scan found no local provider keys, environment files, or workspace data in 1071 files.

Detailed evidence is in `artifacts/solana-dots/verification-summary.json`, `native-verification.json`, `installed-verification.json`, `installed-normal-launch.json`, `bundle-audit.json`, and `../clawd/artifacts/solana-dots-release/live-verification.json`.

The Mac app's existing local provider configuration is encrypted through Electron safeStorage and macOS Keychain. OpenRouter defaults to `anthropic/claude-haiku-5.5` and passed visible desktop and paired-browser chat. The existing working CLAWD Computer xAI configuration was also validated and saved securely. Mem0 is configured; its memory controls are included. Provider credentials are excluded from the distributed app. Each downloaded installation starts its own workspace and provider setup.

## Remaining step

Create the local `clawd-bot-notary` Keychain credential profile using the command in [SOLANA-DOTS-DESKTOP.md](SOLANA-DOTS-DESKTOP.md). If an app-specific password was forgotten, generate another at [Apple Account](https://account.apple.com/) under Sign-In and Security, following [Apple's instructions](https://support.apple.com/en-us/102654). If the main Apple Account password was forgotten, use [Apple password recovery](https://iforgot.apple.com/). Enter passwords only at Apple's secure page or the Terminal credential prompt.

Once profile validation succeeds, run `node finalize-solana-dots.mjs` from `../clawd/desktop-download`. The workflow submits this verified app, requires Apple acceptance, staples and validates the ticket, checks Gatekeeper, uploads the final archive, deploys a frozen manifest, and verifies complete public ZIP bytes through the canonical domain. It also staples the matching Applications installation, including a resumed finalization. The goal remains unfinished until these checks succeed.

Icon generation mode, exact prompt, and output paths are recorded in [ICON-GENERATION.json](ICON-GENERATION.json).
