import { Sandbox, NotFoundError } from '@e2b/desktop';
import { chromium, type Browser, type Page } from 'playwright';
import { posix } from 'node:path';
import type { WorkspaceStore } from './workspace.js';
import type {
  ComputerAction,
  ComputerControl,
} from '../shared/computer-types.js';

type Session = {
  sandbox: Sandbox;
  browser?: Browser;
  page?: Page;
  refs?: Set<string>;
};
const providers = new WeakMap<WorkspaceStore, E2BComputer>();
const workspacePath = '/home/user/opendots-workspace';
const keyAliases: Record<string, string> = {
  Enter: 'Return',
  Escape: 'Escape',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Backspace: 'BackSpace',
  Control: 'ctrl',
};
function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Each Dot has its own authenticated desktop sandbox; API keys stay on the host. */
export class E2BComputer {
  private sessions = new Map<string, Session>();
  private locks = new Map<string, Promise<unknown>>();
  constructor(
    private workspace: WorkspaceStore,
    private apiKey: string,
    private template = 'desktop',
    private timeoutMs = 300_000,
  ) {}
  static for(
    workspace: WorkspaceStore,
    key: string,
    template?: string,
    timeout?: number,
  ) {
    let provider = providers.get(workspace);
    if (!provider) {
      provider = new E2BComputer(workspace, key, template, timeout);
      providers.set(workspace, provider);
    }
    return provider;
  }
  private async serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.locks.set(id, next);
    try {
      return await next;
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id);
    }
  }
  private controlFor(id: string): ComputerControl {
    const state = this.workspace.computers.e2b(id);
    return {
      holder: state?.holder ?? 'bot',
      requested: false,
      transitioning: false,
      resumeSnapshotRequired: state?.resumeSnapshotRequired ?? true,
    };
  }
  async status(id: string) {
    const state = this.workspace.computers.e2b(id);
    if (!state) return { state: 'stopped' as const };
    try {
      const info = await Sandbox.getInfo(state.sandboxId, {
        apiKey: this.apiKey,
      });
      if (
        info.metadata?.opendotsDotId !== id ||
        info.metadata?.opendotsOwnerId !== this.workspace.ownerId
      )
        throw new Error('Computer identity mismatch.');
      return {
        state:
          info.state === 'running'
            ? ('running' as const)
            : ('stopped' as const),
        control: this.controlFor(id),
        sandboxId: state.sandboxId,
      };
    } catch (error) {
      if (error instanceof NotFoundError)
        return {
          state: 'stopped' as const,
          error:
            'This E2B sandbox no longer exists. Start the computer to create a fresh workspace.',
        };
      return {
        state: 'unavailable' as const,
        error: 'E2B is unavailable. Check the API key, quota, and connection.',
      };
    }
  }
  async start(id: string) {
    return this.serial(id, async () => {
      let state = this.workspace.computers.e2b(id);
      let sandbox: Sandbox | undefined;
      if (state) {
        try {
          const info = await Sandbox.getInfo(state.sandboxId, {
            apiKey: this.apiKey,
          });
          if (
            info.metadata?.opendotsDotId !== id ||
            info.metadata?.opendotsOwnerId !== this.workspace.ownerId
          )
            throw new Error('Computer identity mismatch.');
          sandbox = await Sandbox.connect(state.sandboxId, {
            apiKey: this.apiKey,
            timeoutMs: this.timeoutMs,
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          state = undefined;
        }
      }
      if (!sandbox) {
        sandbox = await Sandbox.create(this.template, {
          apiKey: this.apiKey,
          resolution: [1280, 900],
          timeoutMs: this.timeoutMs,
          lifecycle: { onTimeout: 'pause', autoResume: false },
          network: {
            allowPublicTraffic: false,
            maskRequestHost: 'localhost:${PORT}',
          },
          metadata: {
            opendotsDotId: id,
            opendotsOwnerId: this.workspace.ownerId,
          },
        });
      }
      this.workspace.computers.saveE2B(id, {
        sandboxId: sandbox.sandboxId,
        holder: 'bot',
        resumeSnapshotRequired: true,
        snapshotId: (state?.snapshotId ?? 0) + 1,
      });
      const previous = this.sessions.get(id);
      await previous?.browser?.close().catch(() => {});
      this.sessions.set(id, { sandbox });
      await sandbox.files.makeDir(workspacePath);
    });
  }
  async stop(id: string) {
    return this.serial(id, async () => {
      const state = this.workspace.computers.e2b(id);
      if (!state) return;
      await Sandbox.pause(state.sandboxId, { apiKey: this.apiKey });
      await this.sessions
        .get(id)
        ?.browser?.close()
        .catch(() => {});
      this.sessions.delete(id);
      this.workspace.computers.saveE2B(id, {
        ...state,
        holder: 'bot',
        resumeSnapshotRequired: true,
        snapshotId: state.snapshotId + 1,
      });
    });
  }
  async control(id: string, verb: 'take' | 'release') {
    return this.serial(id, async () => {
      const state = this.workspace.computers.e2b(id);
      if (!state || (await this.status(id)).state !== 'running')
        throw new Error('Start this Dot’s computer first.');
      this.workspace.computers.saveE2B(id, {
        ...state,
        holder: verb === 'take' ? 'human' : 'bot',
        resumeSnapshotRequired: true,
        snapshotId: state.snapshotId + 1,
      });
      this.sessions.get(id)?.refs?.clear();
    });
  }
  private async session(id: string) {
    const state = this.workspace.computers.e2b(id);
    if (!state || (await this.status(id)).state !== 'running')
      throw new Error('Start this Dot’s computer first.');
    let session = this.sessions.get(id);
    if (!session || session.sandbox.sandboxId !== state.sandboxId) {
      const sandbox = await Sandbox.connect(state.sandboxId, {
        apiKey: this.apiKey,
        timeoutMs: this.timeoutMs,
      });
      session = { sandbox };
      this.sessions.set(id, session);
      this.workspace.computers.saveE2B(id, {
        ...state,
        resumeSnapshotRequired: true,
        snapshotId: state.snapshotId + 1,
      });
    }
    return session;
  }
  private async browser(session: Session) {
    if (
      session.browser?.isConnected() &&
      session.page &&
      !session.page.isClosed()
    )
      return session.page;
    const sandbox = session.sandbox;
    const host = sandbox.getHost(9222);
    const headers: Record<string, string> = sandbox.trafficAccessToken
      ? { 'e2b-traffic-access-token': sandbox.trafficAccessToken }
      : {};
    let endpoint: string | undefined;
    const running = await sandbox.commands.run(
      'pgrep -f "[r]emote-debugging-port=9222" || true',
      { timeoutMs: 5000 },
    );
    if (!running.stdout.trim())
      await sandbox.commands.run(
        'browser=$(command -v chromium || command -v chromium-browser || command -v google-chrome); exec "$browser" --no-sandbox --remote-debugging-port=9222 --remote-debugging-address=0.0.0.0 --remote-allow-origins=* --user-data-dir=/home/user/opendots-browser --no-first-run --disable-dev-shm-usage about:blank',
        { background: true, envs: { DISPLAY: sandbox.display }, timeoutMs: 0 },
      );
    for (let attempt = 0; attempt < 10; attempt++) {
      const response = await fetch(`https://${host}/json/version`, {
        headers,
        signal: AbortSignal.timeout(5000),
      }).catch(() => undefined);
      if (response?.ok) {
        const info = (await response.json()) as {
          webSocketDebuggerUrl: string;
        };
        const url = new URL(info.webSocketDebuggerUrl);
        endpoint = `wss://${host}${url.pathname}`;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!endpoint)
      throw new Error(
        'E2B browser could not start. Check the desktop template.',
      );
    session.browser = await chromium.connectOverCDP(endpoint, {
      headers,
      timeout: 15000,
    });
    const context = session.browser.contexts()[0];
    session.page = context.pages()[0] ?? (await context.newPage());
    return session.page;
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent',
    signal: AbortSignal,
  ) {
    return this.serial(id, async () => {
      signal.throwIfAborted();
      const session = await this.session(id);
      const state = this.workspace.computers.e2b(id)!;
      const browserAction = !action.startsWith('files_') && action !== 'exec';
      const observation = ['screenshot', 'snapshot', 'read'].includes(action);
      if (actor === 'agent' && state.holder === 'human')
        throw new Error('The owner has control. Wait for them to release it.');
      if (action.startsWith('human_') && state.holder !== 'human')
        throw new Error('Take human control before using desktop controls.');
      if (
        actor === 'agent' &&
        browserAction &&
        !observation &&
        state.resumeSnapshotRequired
      )
        throw new Error(
          'Take computer_snapshot before continuing after a restart or control handback.',
        );
      const data = input as Record<string, string | number | boolean>;
      const sdk = session.sandbox;
      const invalidate = () => {
        const current = this.workspace.computers.e2b(id)!;
        this.workspace.computers.saveE2B(id, {
          ...current,
          snapshotId: current.snapshotId + 1,
        });
        session.refs?.clear();
      };
      let result: unknown;
      if (action === 'exec') {
        const handle = await sdk.commands.run(String(data.command), {
          background: true,
          cwd: workspacePath,
          timeoutMs: Number(data.timeoutMs),
        });
        const abort = () => {
          void handle.kill().catch(() => {});
        };
        signal.addEventListener('abort', abort, { once: true });
        try {
          const output = await handle.wait();
          result = {
            stdout: output.stdout.slice(0, 100000),
            stderr: output.stderr.slice(0, 100000),
            exitCode: output.exitCode,
          };
        } finally {
          signal.removeEventListener('abort', abort);
        }
      } else if (action.startsWith('files_')) {
        const path = posix.join(workspacePath, String(data.path ?? ''));
        // Resolve symlinks in the sandbox so workspace paths cannot escape through an alias.
        const canonical = await sdk.commands.run(
          `realpath -m -- ${shellQuote(path)}`,
          { timeoutMs: 5000 },
        );
        const target = canonical.stdout.trim();
        if (target !== workspacePath && !target.startsWith(workspacePath + '/'))
          throw new Error('File path escapes this Dot’s workspace.');
        if (action === 'files_list')
          result = {
            entries: (await sdk.files.list(target)).map((entry) => ({
              name: entry.name,
              type: entry.type,
              size: entry.size,
            })),
          };
        else if (action === 'files_read') {
          const info = await sdk.files.getInfo(target);
          if (info.size > 100000)
            throw new Error('File exceeds the 100,000 byte limit.');
          result = { text: await sdk.files.read(target) };
        } else {
          await sdk.files.makeDir(posix.dirname(target));
          const text = String(data.contents);
          const previous = data.append
            ? await sdk.files.read(target).catch(() => '')
            : '';
          if (previous.length + text.length > 100000)
            throw new Error('File exceeds the 100,000 character limit.');
          await sdk.files.write(target, previous + text);
          result = { saved: true, path: data.path };
        }
      } else if (action === 'human_click') {
        await sdk.leftClick(Number(data.x), Number(data.y));
        invalidate();
        result = { clicked: true };
      } else if (action === 'human_type') {
        await sdk.write(String(data.text));
        invalidate();
        result = { typed: true };
      } else if (action === 'human_key') {
        await sdk.press(keyAliases[String(data.key)] ?? String(data.key));
        invalidate();
        result = { pressed: true };
      } else if (action === 'human_scroll') {
        await sdk.scroll(
          Number(data.deltaY) < 0 ? 'up' : 'down',
          Math.max(1, Math.ceil(Math.abs(Number(data.deltaY)) / 120)),
        );
        invalidate();
        result = { scrolled: true };
      } else if (action === 'screenshot') {
        const image = Buffer.from(await sdk.screenshot());
        const size = await sdk.getScreenSize();
        result = {
          base64: image.toString('base64'),
          ...size,
          url: session.page?.url() ?? '',
          capturedAt: Date.now(),
        };
      } else {
        const page = await this.browser(session);
        if (action === 'navigate') {
          await page.goto(String(data.url), {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
          });
          invalidate();
          result = { url: page.url(), title: await page.title() };
        } else if (action === 'read')
          result = {
            url: page.url(),
            title: await page.title(),
            text: (await page.locator('body').innerText()).slice(0, 50000),
          };
        else if (action === 'snapshot') {
          invalidate();
          const current = this.workspace.computers.e2b(id)!;
          const elements = await page
            .locator(
              'a,button,input,textarea,select,[role="button"],[contenteditable="true"]',
            )
            .evaluateAll((items) =>
              items
                .filter(
                  (item) =>
                    item.getBoundingClientRect().width > 0 &&
                    item.getBoundingClientRect().height > 0,
                )
                .slice(0, 200)
                .map((item, index) => {
                  const ref = `e${index}`;
                  item.setAttribute('data-opendots-ref', ref);
                  return {
                    ref,
                    tag: item.tagName.toLowerCase(),
                    text: (
                      item.getAttribute('aria-label') ||
                      item.getAttribute('placeholder') ||
                      item.textContent ||
                      ''
                    )
                      .trim()
                      .slice(0, 200),
                  };
                }),
            );
          session.refs = new Set(elements.map((element) => element.ref));
          this.workspace.computers.saveE2B(id, {
            ...current,
            resumeSnapshotRequired: false,
          });
          result = {
            url: page.url(),
            title: await page.title(),
            snapshotId: current.snapshotId,
            elements,
            text: (await page.locator('body').innerText()).slice(0, 30000),
          };
        } else if (action === 'click' || action === 'type') {
          const current = this.workspace.computers.e2b(id)!;
          if (
            data.snapshotId !== current.snapshotId ||
            !session.refs?.has(String(data.ref))
          )
            throw new Error(
              'Stale browser reference. Take computer_snapshot before retrying.',
            );
          const target = page.locator(
            `[data-opendots-ref="${String(data.ref)}"]`,
          );
          if (action === 'click') await target.click({ timeout: 5000 });
          else {
            await target.fill(String(data.text), { timeout: 5000 });
            if (data.submit) await target.press('Enter');
          }
          invalidate();
          result = { completed: true, url: page.url() };
        } else if (action === 'key') {
          await page.keyboard.press(String(data.key));
          invalidate();
          result = { pressed: true };
        } else if (action === 'scroll') {
          await page.mouse.wheel(0, Number(data.deltaY));
          invalidate();
          result = { scrolled: true };
        }
      }
      signal.throwIfAborted();
      return result;
    });
  }
}
