/** Installs a preparation-only connector. Read the token on stdin, never argv. */
import { WorkspaceStore } from '../src/server/workspace.js';
import { ConnectionService } from '../src/server/connections.js';
const url =
  process.env.CLAWD_MAIL_LAUNCH_URL ||
  'https://mail.musebook.trade/api/launch-mcp';
if (new URL(url).protocol !== 'https:')
  throw new Error('Use an HTTPS CLAWD Mail MCP URL.');
let token = '';
for await (const bytes of process.stdin) token += String(bytes);
token = token.trim();
if (!/^[a-zA-Z0-9_-]{43}$/.test(token))
  throw new Error('Read a CLAWD Mail connection key on stdin.');
const workspace = new WorkspaceStore(
  process.env.DATABASE_PATH || 'data/opendots.sqlite',
  process.env.OWNER_ID || 'opendots-owner',
);
try {
  const dotName = process.env.CLAWD_MAIL_DOT_NAME || 'clawd';
  const dot = workspace
    .dots()
    .find((item) => item.name.toLowerCase() === dotName.toLowerCase());
  if (!dot) throw new Error('Choose an existing Dot with CLAWD_MAIL_DOT_NAME.');
  const service = new ConnectionService(workspace.connections);
  const existing = workspace.connections
    .list(dot.id)
    .find((item) => item.url === url && item.name === 'CLAWD Mail Launch');
  if (
    existing &&
    workspace.connections.credentials(existing.id).token === token
  ) {
    const result = await service.refresh(existing.id);
    if (result.error) throw new Error(result.error);
    console.log(
      JSON.stringify({
        dot: dot.name,
        connectionId: result.id,
        tools: result.tools.map((tool) => tool.name),
        reused: true,
      }),
    );
  } else {
    const connection = await service.add(dot.id, {
      name: 'CLAWD Mail Launch',
      url,
      token,
    });
    if (existing) workspace.connections.remove(existing.id);
    workspace.updateDot(dot.id, {
      name: dot.name,
      researchAllowed: dot.researchAllowed,
      memoryAllowed: dot.memoryAllowed,
      instructions: dot.instructions.includes(
        'For launch requests using email or the Privy launch wallet',
      )
        ? dot.instructions
        : dot.instructions +
          '\nFor launch requests using email or the Privy launch wallet, use the CLAWD Mail Launch connection to prepare a draft and return its owner review link. These tools never sign or broadcast. The mailbox owner approves the transaction in CLAWD Mail. Keep local OWS wallet requests in the existing Mac Pump review flow.',
    });
    console.log(
      JSON.stringify({
        dot: dot.name,
        connectionId: connection.id,
        tools: connection.tools.map((tool) => tool.name),
        signingTools: false,
      }),
    );
  }
} finally {
  workspace.close();
}
