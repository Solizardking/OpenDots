# Launch by email with CLAWD Mail

CLAWD Mail at `https://mail.musebook.trade` exposes a preparation-only MCP connector at `https://mail.musebook.trade/api/launch-mcp`. Your existing OpenDots Connections service can use it without sharing Privy credentials or changing this workspace's sign-in app.

On CLAWD Mail's account page, open **Launch on Pump.fun → Ask CLAWD from OpenDots**, choose your inbox, and create an inbox connection key. In the `clawd` Dot's settings, add **CLAWD Mail Launch** with the MCP URL and bearer token. Ask Clawd to prepare a coin with its exact name, symbol, and published metadata URI. The connection review card approves draft creation; follow the returned link to approve the actual transaction with your funded Privy launch wallet on CLAWD Mail.

The connector exposes `prepare_pump_launch`, `get_pump_launch`, and `list_pump_launches`. Its token is scoped to one approved inbox. It cannot sign, broadcast, approve purchases or select arbitrary wallets. Revoke it from the launch panel. Use a stable UUID `requestId` when retrying draft preparation.

You can also send a launch request directly to your CLAWD Mail inbox with a coin image and description. CLAWD prepares it and replies with the same review link. The local OpenDots OWS Pump tools keep their existing Mac wallet approval flow; requests for the email/Privy launch wallet use the **CLAWD Mail Launch** connection.

Implementation and verification: [/Users/8bit/Downloads/agent-mail/docs/PUMP-LAUNCH.md](/Users/8bit/Downloads/agent-mail/docs/PUMP-LAUNCH.md).
