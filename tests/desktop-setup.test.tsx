import { createElement } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DesktopSetup } from '../src/client/DesktopSetup';
import type { DesktopSettings } from '../src/shared/desktop-types';

// The real api module reads sessionStorage at load; the desktop xAI status
// check is incidental here, so answer it disconnected.
vi.mock('../src/client/api', () => ({
  api: vi.fn(async () => ({ connected: false })),
  setToken: vi.fn(),
}));

let root: ReactTestRenderer | undefined;
const saveSettings = vi.fn();
const settings: DesktopSettings = {
  values: {},
  configured: [],
  version: 'fixture',
};

beforeEach(() => {
  settings.values = {};
  settings.configured = [];
  saveSettings.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('window', {
    solanaDots: {
      settings: async () => settings,
      saveSettings,
    },
  });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root = create(createElement(DesktopSetup));
  });
}

const input = (id: string) => root!.root.findByProps({ id });
const saveButton = () =>
  root!.root
    .findAllByType('button')
    .find((button) => button.props.className === 'primary full')!;

it('shows Muse Wonder for a new OpenRouter setup even when a batch model is configured', async () => {
  settings.values = { OPENROUTER_CLAUDE_MODEL: 'anthropic/batch-only' };
  await render();
  expect(input('model-provider').props.value).toBe('openrouter');
  expect(input('desktop-model').props.value).toBe('meta/muse-wonder');
  expect(
    root!.root.findAllByType('small').map((node) => node.children.join('')),
  ).toContain('Muse Wonder chat');
  expect(saveButton().props.disabled).toBe(true);
});

it('uses the saved Muse model ahead of legacy and batch values and writes edits to the new setting', async () => {
  settings.values = {
    OPENROUTER_MUSEMODEL: ' meta/muse-wonder ',
    OPENROUTER_MODEL: 'saved/legacy-live',
    OPENROUTER_CLAUDE_MODEL: 'anthropic/batch-only',
  };
  await render();
  expect(input('desktop-model').props.value).toBe('meta/muse-wonder');
  await act(async () => {
    input('desktop-model').props.onChange({
      target: { value: 'custom/live-model' },
    });
  });
  await act(async () => saveButton().props.onClick());
  expect(saveSettings).toHaveBeenCalledWith({
    OPENROUTER_MUSEMODEL: 'custom/live-model',
  });
  expect(settings.values.OPENROUTER_MODEL).toBe('saved/legacy-live');
  expect(settings.values.OPENROUTER_CLAUDE_MODEL).toBe('anthropic/batch-only');
});

it.each([undefined, '', '  '])(
  'preserves a saved legacy live model when Muse is absent (%s)',
  async (museModel) => {
    settings.values = {
      OPENROUTER_MODEL: ' legacy/live-model ',
      OPENROUTER_CLAUDE_MODEL: 'anthropic/batch-only',
      ...(museModel === undefined ? {} : { OPENROUTER_MUSEMODEL: museModel }),
    };
    settings.configured = ['OPENROUTER_API_KEY'];
    await render();
    expect(input('desktop-model').props.value).toBe('legacy/live-model');
    expect(input('provider-OPENROUTER_API_KEY').props.value).toBe('');
    await act(async () => {
      input('provider-OPENROUTER_API_KEY').props.onChange({
        target: { value: 'fixture-new-key' },
      });
    });
    await act(async () => saveButton().props.onClick());
    expect(saveSettings).toHaveBeenCalledWith({
      OPENROUTER_API_KEY: 'fixture-new-key',
    });
  },
);

it.each([
  ['xai', 'XAI_MODEL', 'custom/grok'],
  ['openai', 'OPENAI_MODEL', 'custom/openai'],
])(
  'keeps the explicitly selected %s provider and its model setting',
  async (provider, modelKey, model) => {
    settings.values = {
      MODEL_PROVIDER: provider,
      [modelKey]: model,
      OPENROUTER_MUSEMODEL: 'meta/muse-wonder',
    };
    await render();
    expect(input('model-provider').props.value).toBe(provider);
    expect(input('desktop-model').props.value).toBe(model);
    await act(async () => {
      input('desktop-model').props.onChange({
        target: { value: 'custom/replacement' },
      });
    });
    await act(async () => saveButton().props.onClick());
    expect(saveSettings).toHaveBeenCalledWith({
      [modelKey]: 'custom/replacement',
    });
  },
);
