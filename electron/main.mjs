import { app, BrowserWindow, ipcMain, Menu, nativeImage, powerSaveBlocker, safeStorage, shell, utilityProcess, dialog, session } from 'electron';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

app.setName('Solana Dots');
const directory = dirname(fileURLToPath(import.meta.url));
const resources = app.isPackaged ? process.resourcesPath : resolve(process.env.DOTS_ARTIFACT_DIRECTORY || join(directory, '../artifacts/solana-dots'), 'runtime');
const keys = new Set(['OPENROUTER_API_KEY','XAI_API_KEY','OPENAI_API_KEY','VOICE_API_KEY','E2B_API_KEY','BROWSER_USE_API_KEY','PARALLEL_API_KEY','COPILOTKIT_INTELLIGENCE_API_KEY','MEM0_API_KEY','SUPERMEMORY_API_KEY','TYPESAFE_API_KEY','JUPITER_API_KEY','JUP_SWAP_V1_API_KEY','OPENMARKET_API_KEY','SOLANA_RPC_URL']);
const fields = new Set(['MODEL_PROVIDER','OPENROUTER_MODEL','OPENROUTER_CLAUDE_MODEL','XAI_MODEL','OPENAI_MODEL','VOICE_MODEL','VOICE_NAME','XAI_IMAGE_MODEL','BROWSER_USE_MODEL','MEM0_BASE_URL','MEM0_ORG_ID','MEM0_PROJECT_ID']);
const token = randomBytes(32).toString('hex');
let window, child, origin = '', keepAwake = false, blocker;
let settings = {}, pending = new Map();
let closing = false;
const configPath = join(app.getPath('userData'), 'credentials.bin');
function log(value) {
  let text = String(value);
  for (const key of keys) if (settings[key]) text = text.split(settings[key]).join('[redacted]');
  text = text.split(token).join('[redacted]');
  const path = join(app.getPath('logs'), 'desktop.log');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `[${new Date().toISOString()}] ${text.slice(0, 4000)}\n`, { flag: 'a', mode: 0o600 });
}
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });
const trusted = event => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || new URL(event.senderFrame.url).origin !== origin) throw Error('Untrusted desktop request.');
};
const publicSettings = () => ({ values: Object.fromEntries(Object.entries(settings).filter(([k]) => fields.has(k))), configured: [...keys].filter(k => !!settings[k]), version: app.getVersion() });
async function readSettings() {
  if (!existsSync(configPath)) return {};
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw Error('macOS Keychain is unavailable. Unlock your login keychain, then restart Solana Dots.');
  const decrypted = await safeStorage.decryptStringAsync(readFileSync(configPath));
  const result = typeof decrypted === 'string' ? decrypted : decrypted.result;
  if (typeof result !== 'string') throw Error('macOS Keychain could not decrypt the saved provider settings.');
  const parsed = JSON.parse(result);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object' || Object.entries(parsed).some(([key, value]) => (!keys.has(key) && !fields.has(key)) || typeof value !== 'string')) throw Error('Saved provider settings are invalid.');
  if (decrypted.shouldReEncrypt) await writeSettings(parsed);
  return parsed;
}
async function writeSettings(next) {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw Error('macOS Keychain is unavailable. Your credentials were not saved.');
  const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(next));
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  writeFileSync(configPath + '.tmp', encrypted, { mode: 0o600 });
  renameSync(configPath + '.tmp', configPath);
}
async function startServer() {
  if (child) {
    const previous = child; child = undefined;
    await new Promise(resolve => {
      const timeout = setTimeout(() => { previous.kill(); resolve(); }, 3000);
      previous.once('exit', () => { clearTimeout(timeout); resolve(); });
      previous.postMessage({ action: 'shutdown' });
    });
  }
  child = utilityProcess.fork(join(resources, 'server/desktop-server.mjs'), [], {
    serviceName: 'Solana Dots workspace', stdio: 'pipe',
    env: { PATH: process.env.PATH, HOME: app.getPath('home'), TMPDIR: app.getPath('temp'), DO_NOT_TRACK: '1', NODE_ENV: 'production' },
  });
  child.stdout?.on('data', () => {});
  child.stderr?.on('data', data => log(data));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('The local workspace did not start.')), 30000);
    child.on('message', message => {
      if (message.ready) { clearTimeout(timer); origin = message.origin; resolve(); }
      else if (message.id && pending.has(message.id)) {
        const request = pending.get(message.id); pending.delete(message.id); clearTimeout(request.timer);
        message.error ? request.reject(Error(message.error)) : request.resolve(message.result);
      } else if (message.error) { log(message.detail || message.error); clearTimeout(timer); reject(Error(message.error)); }
    });
    child.once('exit', () => { clearTimeout(timer); reject(Error('The workspace process stopped.')); });
  });
  child.postMessage({ action: 'initialize', options: { dataPath: join(app.getPath('userData'), 'workspace'), clientPath: join(resources, 'client'), token, env: settings } });
  await ready;
  // The shell-only proof is distinct from the API owner bearer token.
  // Cookies do not have port scope; never put that bearer token in a cookie.
  await session.defaultSession.cookies.set({
    url: origin + '/', name: 'chatgptee_desktop_page',
    value: createHash('sha256').update('chatgptee-desktop-page:' + token).digest('hex'),
    path: '/', httpOnly: true, sameSite: 'strict', secure: false,
  });
}
function companion(action, value) {
  return new Promise((resolve, reject) => {
    if (!child) return reject(Error('The workspace is unavailable.'));
    const id = randomUUID(); const timer = setTimeout(() => { pending.delete(id); reject(Error('Phone service timed out.')); }, 10000);
    pending.set(id, { resolve: state => { if (!state.enabled) setKeepAwake(false); resolve({ ...state, keepAwake }); }, reject, timer });
    child.postMessage({ id, action, value });
  });
}
function setKeepAwake(enabled) {
  keepAwake = enabled;
  if (enabled && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  if (!enabled && blocker !== undefined) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
ipcMain.handle('dots:session', event => { trusted(event); return { token }; });
ipcMain.handle('dots:settings', event => { trusted(event); return publicSettings(); });
ipcMain.handle('dots:save-settings', async (event, values) => {
  trusted(event);
  if (!values || Array.isArray(values) || typeof values !== 'object') throw Error('Invalid settings.');
  const next = { ...settings };
  for (const [name, value] of Object.entries(values)) {
    if ((!keys.has(name) && !fields.has(name)) || typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value)) throw Error('Invalid provider setting.');
    if (value.trim()) next[name] = value.trim(); else delete next[name];
  }
  if (next.MODEL_PROVIDER && !['openrouter','xai','openai'].includes(next.MODEL_PROVIDER)) throw Error('Choose OpenRouter, xAI, or OpenAI.');
  await writeSettings(next); settings = next; setKeepAwake(false);
  await startServer(); await window.loadURL(origin);
});
ipcMain.handle('dots:companion', async (event, action, value) => {
  trusted(event);
  if (!['state','start','stop','pair','cancel','revoke'].includes(action) || (value !== undefined && (typeof value !== 'string' || value.length > 128))) throw Error('Invalid Phone action.');
  return companion(action, value);
});
ipcMain.handle('dots:keep-awake', async (event, enabled) => { trusted(event); if (typeof enabled !== 'boolean') throw Error('Invalid setting.'); const state = await companion('state'); setKeepAwake(enabled && state.enabled); return { ...state, keepAwake }; });
app.whenReady().then(async () => {
  try {
    settings = await readSettings();
    await startServer();
    const icon = join(resources, 'app-icon.png'); if (existsSync(icon)) app.dock?.setIcon(nativeImage.createFromPath(icon));
    window = new BrowserWindow({ width: 1340, height: 900, minWidth: 760, minHeight: 600, title: 'Solana Dots', titleBarStyle: 'hiddenInset', backgroundColor: '#101014', show: false, webPreferences: { preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: true } });
    window.webContents.setWindowOpenHandler(({ url }) => {
      try { const parsed = new URL(url); if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) void shell.openExternal(parsed.href); } catch {}
      return { action: 'deny' };
    });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) event.preventDefault(); });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback) => callback(contents === window.webContents && new URL(contents.getURL()).origin === origin && ['media','clipboard-sanitized-write'].includes(permission)));
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => contents === window.webContents && requestingOrigin === origin && ['media','clipboard-sanitized-write'].includes(permission));
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'Solana Dots', submenu: [{ role: 'about' }, { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => window.webContents.send('dots:action', 'settings') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' },
      { label: 'Workspace', submenu: [{ label: 'New Conversation', accelerator: 'CmdOrCtrl+N', click: () => window.webContents.send('dots:action','new-chat') }, { label: 'Phone', click: () => window.webContents.send('dots:action','phone') }] },
      { role: 'viewMenu' }, { role: 'windowMenu' },
    ]));
    window.once('ready-to-show', () => window.show()); await window.loadURL(origin);
  } catch (error) { log(error.message); dialog.showErrorBox('Solana Dots could not start', error.message); app.quit(); }
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (closing) return;
  closing = true; event.preventDefault(); setKeepAwake(false);
  child?.postMessage({ action: 'shutdown' });
  const timeout = setTimeout(() => { child?.kill(); app.exit(); }, 3000);
  if (child) child.once('exit', () => { clearTimeout(timeout); app.exit(); }); else { clearTimeout(timeout); app.exit(); }
});
