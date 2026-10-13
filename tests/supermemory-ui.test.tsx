import { StrictMode, createElement, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Connection } from '../src/shared/connection-types';

const fixture = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('../src/client/api', () => ({ api: fixture.api }));
vi.mock('../src/client/AuthGate', () => ({
  AuthFrame: ({ children }: { children: ReactNode }) => children,
}));
import {
  ConnectionsSection,
  isSupermemoryServer,
} from '../src/client/ConnectionsSection';
import SupermemoryCallback, {
  captureSupermemoryCallback,
} from '../src/client/SupermemoryCallback';

let root: ReactTestRenderer | undefined;
const connection = (
  authStatus: Connection['authStatus'] = 'connected',
): Connection => ({
  id: 'supermemory-one',
  dotId: 'dot-one',
  name: 'Supermemory',
  url: 'https://mcp.supermemory.ai/mcp',
  hasToken: authStatus === 'connected',
  provider: 'supermemory',
  auth: 'oauth',
  authStatus,
  tools: [],
  error: null,
  createdAt: 1,
  updatedAt: 1,
});
const visible = () => JSON.stringify(root!.toJSON());
const button = (label: string) =>
  root!.root
    .findAllByType('button')
    .find(
      (node) =>
        node.children.filter((child) => typeof child === 'string').join('') ===
        label,
    )!;
async function mountConnections() {
  await act(async () => {
    root = create(createElement(ConnectionsSection, { dotId: 'dot-one' }));
  });
}
beforeEach(() => {
  fixture.api.mockReset();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    location: { assign: vi.fn() },
    confirm: vi.fn(() => true),
  });
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

it('captures the OAuth response and removes it from the URL before displaying any UI', () => {
  const clean = vi.fn();
  const captured = captureSupermemoryCallback(
    '?code=test-only-code&state=test-only-state&iss=https%3A%2F%2Fmcp.supermemory.ai',
    clean,
  );
  expect(clean).toHaveBeenCalledOnce();
  expect(captured).toEqual({
    code: 'test-only-code',
    state: 'test-only-state',
    iss: 'https://mcp.supermemory.ai',
  });
  expect(
    captureSupermemoryCallback(
      '?code=first&code=second&state=test-only-state',
      clean,
    ),
  ).toHaveProperty('error');
  expect(
    captureSupermemoryCallback('?code=test-only-code', clean),
  ).toHaveProperty('error');
  expect(
    captureSupermemoryCallback(
      '?code=test-only-code&state=test-only-state&iss=one&iss=two',
      clean,
    ),
  ).toHaveProperty('error');
});

it('completes the authenticated callback once under StrictMode without displaying its authorization code', async () => {
  fixture.api.mockResolvedValue(connection());
  const request = {
    code: 'test-only-code',
    state: 'test-only-state',
    iss: 'https://mcp.supermemory.ai',
  };
  await act(async () => {
    root = create(
      createElement(
        StrictMode,
        null,
        createElement(SupermemoryCallback, { request }),
      ),
    );
  });
  expect(fixture.api).toHaveBeenCalledOnce();
  expect(fixture.api).toHaveBeenCalledWith(
    '/connections/supermemory/oauth/finish',
    'POST',
    request,
  );
  expect(visible()).toContain('Supermemory connected.');
  expect(visible()).not.toContain('test-only-code');
  expect(visible()).not.toContain('test-only-state');
});

it('shows declined or invalid callbacks with a restart path and never submits them', async () => {
  const request = captureSupermemoryCallback(
    '?error=access_denied&error_description=untrusted-provider-message',
    vi.fn(),
  );
  await act(async () => {
    root = create(createElement(SupermemoryCallback, { request }));
  });
  expect(fixture.api).not.toHaveBeenCalled();
  expect(visible()).toContain('authorization was declined');
  expect(visible()).toContain('Return to workspace');
  expect(visible()).not.toContain('untrusted-provider-message');
});

it('shows callback completion failures and directs the user to restart authorization', async () => {
  fixture.api.mockRejectedValue(new Error('This authorization has expired.'));
  await act(async () => {
    root = create(
      createElement(SupermemoryCallback, {
        request: { code: 'test-only-code', state: 'test-only-state' },
      }),
    );
  });
  expect(visible()).toContain('This authorization has expired.');
  expect(visible()).toContain('Continue authorization');
  expect(visible()).toContain('Return to workspace');
});

it('starts dedicated Supermemory OAuth with no API key or manual token', async () => {
  fixture.api.mockImplementation(async (path: string) =>
    path === '/dots/dot-one/connections'
      ? []
      : {
          connection: connection('pending'),
          authorizationUrl:
            'https://mcp.supermemory.ai/oauth/authorize?fixture=1',
        },
  );
  await mountConnections();
  await act(async () => {
    await button('Connect Supermemory').props.onClick();
  });
  expect(fixture.api).toHaveBeenLastCalledWith(
    '/dots/dot-one/connections/supermemory',
    'POST',
    {},
  );
  expect(window.location.assign).toHaveBeenCalledWith(
    'https://mcp.supermemory.ai/oauth/authorize?fixture=1',
  );
});

it('recognizes only the canonical Supermemory MCP URL and hides generic credential inputs for it', async () => {
  expect(isSupermemoryServer('https://mcp.supermemory.ai/mcp/')).toBe(true);
  for (const url of [
    'http://mcp.supermemory.ai/mcp',
    'https://mcp.supermemory.ai.evil.example/mcp',
    'https://mcp.supermemory.ai/mcp?key=fixture',
    'https://user:fixture@mcp.supermemory.ai/mcp',
  ])
    expect(isSupermemoryServer(url)).toBe(false);
  fixture.api.mockResolvedValue([]);
  await mountConnections();
  const genericToken = root!.root.findByProps({
    'aria-label': 'Bearer token (optional)',
  });
  await act(async () => {
    genericToken.props.onChange({ target: { value: 'fixture-generic-token' } });
  });
  const urlInput = root!.root.findByProps({ 'aria-label': 'MCP server URL' });
  await act(async () => {
    urlInput.props.onChange({
      target: { value: 'https://mcp.supermemory.ai/mcp' },
    });
  });
  expect(
    root!.root.findAllByProps({ 'aria-label': 'Bearer token (optional)' }),
  ).toHaveLength(0);
  expect(
    root!.root.findAllByProps({ 'aria-label': 'MCP server name' }),
  ).toHaveLength(0);
  fixture.api.mockResolvedValue({
    connection: connection('pending'),
    authorizationUrl: 'https://mcp.supermemory.ai/oauth/authorize',
  });
  const genericAdd = root!.root
    .findByProps({ className: 'connection-add' })
    .findByType('button');
  await act(async () => {
    await genericAdd.props.onClick();
  });
  expect(fixture.api).toHaveBeenLastCalledWith(
    '/dots/dot-one/connections/supermemory',
    'POST',
    {},
  );
  expect(fixture.api.mock.calls.flat()).not.toContain('fixture-generic-token');
});

it('keeps pending and expired connections visible with an explicit authorization action', async () => {
  fixture.api.mockResolvedValue([connection('pending')]);
  await mountConnections();
  expect(visible()).toContain('authorization pending');
  expect(visible()).not.toContain('This server offers no tools');
  expect(
    root!.root.findByProps({ 'aria-label': 'Refresh Supermemory tools' }).props
      .disabled,
  ).toBe(true);
  fixture.api.mockResolvedValue({
    connection: connection('pending'),
    authorizationUrl: 'https://mcp.supermemory.ai/oauth/authorize',
  });
  await act(async () => {
    await button('Continue authorization').props.onClick();
  });
  expect(fixture.api).toHaveBeenLastCalledWith(
    '/connections/supermemory-one/oauth/start',
    'POST',
    {},
  );
  await act(async () => root!.unmount());
  fixture.api.mockResolvedValue([connection('expired')]);
  await mountConnections();
  expect(visible()).toContain('reconnect required');
  expect(button('Reauthorize Supermemory').props.disabled).toBe(false);
});

it('loads spaces without switching them and changes the active space only after explicit confirmation', async () => {
  fixture.api.mockImplementation(async (path: string) => {
    if (path === '/dots/dot-one/connections') return [connection()];
    if (path.endsWith('/spaces'))
      return {
        spaces: [
          { namespace: 'personal', name: 'Personal' },
          { namespace: 'team', name: 'Team research' },
        ],
        activeNamespace: 'personal',
        identity: { text: 'Account context that is not displayed verbatim' },
      };
    return {
      activeNamespace: 'team',
      result: { isError: false, text: 'Changed' },
    };
  });
  await mountConnections();
  expect(visible()).toContain('Personal');
  expect(visible()).not.toContain(
    'Account context that is not displayed verbatim',
  );
  expect(fixture.api).toHaveBeenCalledTimes(2);
  expect(button('Set active space').props.disabled).toBe(true);
  await act(async () => {
    root!.root
      .findByType('select')
      .props.onChange({ target: { value: 'team' } });
  });
  expect(fixture.api).toHaveBeenCalledTimes(2);
  await act(async () => {
    await button('Set active space').props.onClick();
  });
  expect(fixture.api).toHaveBeenLastCalledWith(
    '/connections/supermemory-one/supermemory/space',
    'POST',
    { namespace: 'team' },
  );
  expect(visible()).toContain('Active Supermemory space updated.');
  expect(button('Set active space').props.disabled).toBe(true);
});
