# Solana Dots for Mac

Solana Dots uses this OpenDots checkout for its UI, chat runtime, Spaces, pages, agent computers, model tools, and wallet tools. Its macOS shell adds a native menu, encrypted provider settings, a separate local workspace, and a phone companion. The original installed Clawd Bot app is the visual and interaction reference.

## Run and package

```sh
npm ci
npm run desktop:dev
npm run desktop:package
```

The signed Apple Silicon app and ZIP are produced under `artifacts/solana-dots/release/`. The packaged Electron version determines the minimum macOS version recorded in `release.json`; the current runtime requires macOS 13. Provider keys, `.env`, local data, and development scripts are excluded from the app bundle.

The Mac workspace is stored in `~/Library/Application Support/Solana Dots/workspace/`. This is separate from the hosted OpenDots workspace and Clawd Bot's workspace. Existing hosted account sign-in remains available through the normal web server.

## Provider setup

Open **Settings & setup** and enter your OpenRouter key. The shared default is `meta/muse-wonder`; choose **OpenRouter** as the chat provider and keep that exact model ID. The local server uses `OPENROUTER_MUSEMODEL` for live chat; `OPENROUTER_CLAUDE_MODEL` remains separate for Claude batches. Explicit xAI and OpenAI alternatives remain available. Additional provider connections are optional:

| Connection                           | Feature                                         |
| ------------------------------------ | ----------------------------------------------- |
| OpenRouter (default), xAI, or OpenAI | Chat and scheduled agent turns                  |
| xAI                                  | Avatar generation and permission-gated X Search |
| E2B                                  | Cloud desktop computers                         |
| Browser Use                          | Browser sessions                                |
| Parallel                             | Web research                                    |
| Voice key and model                  | Live calls                                      |
| CopilotKit Intelligence              | Cloud storage and learning                      |
| Mem0                                 | Long-term recall for permitted Dots             |

Provider credentials are encrypted with Electron's macOS Keychain-backed `safeStorage`. Only configured/not-configured flags and non-secret model preferences return to the UI. Saving restarts the local workspace and turns phone access off. The phone cannot read or change provider credentials or sign with a wallet.

Chat, model generation, calls, and cloud computers depend on your provider accounts, their permissions, and available quota. The UI shows missing setup before starting those features.

## Drawers and native controls

- The sidebar selects Dots, Spaces, conversations, activity, and memories.
- Agent editing opens a right drawer for instructions, avatars, Space access, Learning, connected tools, and wallet configuration.
- Settings opens a right drawer for appearance, permissions, and provider setup.
- The computer button opens the existing computer panel beside the conversation.
- Phone opens pairing and device controls in a right drawer.
- `⌘,` opens Settings; `⌘N` starts a conversation. The native menu also opens Phone.
- Escape closes drawers; keyboard focus stays within an open dialog and returns on close.

## Pair a phone

1. Keep the Mac and phone on the same trusted Wi-Fi network.
2. Open **Phone** in the Mac app and enable Phone access.
3. Create a pairing code. Scan the QR with the phone camera and open the page.
4. Name the device and tap **Pair with Mac**.
5. Continue in the mobile browser. You can add the site to the phone's home screen using the browser's normal controls.

This is a mobile browser companion for Solana Dots. The existing Clawd Bot iOS client's API is a different protocol. Remote internet pairing and native iOS app distribution are not included in this release.

Phone chat shares the Mac's conversation history and supports reading and editing Space pages. Calls and computer takeover controls stay in the Mac app; a LAN HTTP page cannot request a phone microphone through a secure browser context.

Local pairing uses HTTP, matching a local-network workflow. Enable it only on a trusted private network. The main desktop API binds to loopback; the companion listener is off at launch until explicitly enabled. Codes expire after two minutes and are consumed once. Five incorrect attempts invalidate the code. At most eight devices can pair; their sessions expire after 30 days. Only token hashes persist on the Mac, and the phone receives an HttpOnly, SameSite cookie.

The paired-device API explicitly allows workspace reads, conversations, pages, and conversation transport. Wallet signing, wallet credentials, provider changes, connection management, and unrecognized APIs are denied. Revoke a device from the Mac to invalidate its cookie immediately. Turning Phone access off stops the listener and cancels pairing. Keep-awake is opt-in and ends when phone access stops or the app quits.

## Sign, notarize, and publish

Signing uses `Developer ID Application: James Knox (MU4489QPHP)` with hardened runtime and Apple's secure timestamp. Native wallet bindings are signed with the same identity. `codesign --verify --deep --strict` must pass before packaging.

Create a local Keychain profile without putting the Apple password in source or command arguments:

```sh
xcrun notarytool store-credentials "clawd-bot-notary" \
  --apple-id "beetsbyj@gmail.com" \
  --team-id "MU4489QPHP"
npm run desktop:notarize
```

The notarization script requires Apple `Accepted`, staples the ticket, validates it, runs Gatekeeper, recreates the ZIP, and updates its checksum. It never marks a rejected or pending submission notarized.

The download service in `../clawd/desktop-download/` hosts the new page at `https://app.clawdbot.party/solana-dots`. Upload the exact checked archive using `node upload-solana-dots.mjs`, then deploy matching frozen service inputs. The service verifies all private storage parts and the assembled SHA-256 before exposing bytes. The new download endpoint additionally requires `signed: true` and `notarized: true`. The previous Clawd Bot edition ledger and activation service are retained.

## Verification

```sh
npm run typecheck
npm run lint
npm test
node scripts/verify-desktop.mjs
```

`verify-desktop.mjs` launches the signed app and a separate mobile browser against the real LAN listener, verifies pairing/replay/revocation and denied mutations, and captures the actual UI. It is browser emulation, not a physical phone hardware test. Use `--live-chat` to make one model request through the visible composer. `--import-local-config` is an explicit local setup utility that encrypts existing `.env` provider configuration on this Mac; it does not add credentials to release artifacts.

## Icon

Source mascot: user-supplied `image-1.png`. The new icon was generated with the built-in imagegen tool and copied to `public/brand/solana-dots-icon.png`; the original mascot is `public/brand/solana-dots-mascot.png`. Packaging converts the generated raster into a multi-resolution `.icns` using macOS `sips` and `iconutil`.

Final prompt: “Use case: stylized-concept. Asset type: official macOS application icon for Solana Dots. Input image 1 is a character identity reference: the friendly furry claw-shaped mascot with mint green to cyan to violet fur, large glossy brown eyes, small smile, and the Solana patch. Create a distinctive polished macOS icon based on this exact mascot. Center the mascot in a rounded square dark navy glass tile with soft depth and subtle luminous teal and purple edges, generous transparent padding outside the tile. Keep the face expressive and recognizable and the three-stripe Solana chest patch legible. Simplify the mascot's silhouette and fur detail enough that the face reads clearly at small Dock sizes. Premium friendly 3D app icon, straight on, crisp clean edges, balanced square composition, no letters, no words, no watermark, no additional subjects. Transparent background outside the rounded-square tile.”

References: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [Apple notarization](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow), and [Apple app-specific passwords](https://support.apple.com/en-us/102654).
