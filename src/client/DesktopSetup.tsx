import { useEffect, useState } from 'react';
import { KeyRound, Check, ShieldCheck } from 'lucide-react';
import type { DesktopSettings } from '../shared/desktop-types';
const providers = [
  [
    'SUPERMEMORY_API_KEY',
    'Supermemory',
    'Private trading journal and memory graph',
  ],
  ['TYPESAFE_API_KEY', 'TypeSafe', 'Typed trading decisions'],
  [
    'JUPITER_API_KEY',
    'Jupiter',
    'Token intelligence and wallet-approved swaps',
  ],
  ['OPENROUTER_API_KEY', 'OpenRouter', 'Muse Wonder chat'],
  ['XAI_API_KEY', 'xAI', 'Chat and avatar generation'],
  ['OPENAI_API_KEY', 'OpenAI', 'Alternative chat provider'],
  ['E2B_API_KEY', 'E2B', 'Agent desktop computers'],
  ['BROWSER_USE_API_KEY', 'Browser Use', 'Agent browser sessions'],
  ['PARALLEL_API_KEY', 'Parallel', 'Web research'],
  ['VOICE_API_KEY', 'Voice', 'Live calls'],
  ['MEM0_API_KEY', 'Mem0', 'Long-term memory for each permitted Dot'],
  [
    'OPENMARKET_API_KEY',
    'OpenMarket',
    'Crypto charts, orderbook heatmaps and Polymarket research',
  ],
  [
    'BIRDEYE_API_KEY',
    'Birdeye',
    'Read-only token, wallet and market research through Birdeye MCP and Data API',
  ],
  [
    'SOLANA_RPC_URL',
    'Solana mainnet RPC',
    'Pump.fun launches and trades. Optional HTTPS provider URL; defaults to public mainnet.',
  ],
  [
    'COPILOTKIT_INTELLIGENCE_API_KEY',
    'CopilotKit Intelligence',
    'Optional cloud conversation storage and learning',
  ],
] as const;
export function DesktopSetup() {
  const [settings, setSettings] = useState<DesktopSettings>();
  const [changes, setChanges] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    void window.solanaDots
      ?.settings()
      .then(setSettings)
      .catch(() => setError('Could not read provider settings.'));
  }, []);
  if (!window.solanaDots) return null;
  const field = (key: string, fallback = '') =>
    changes[key] ?? settings?.values[key] ?? fallback;
  const modelProvider = field('MODEL_PROVIDER', 'openrouter');
  const modelKey =
    modelProvider === 'openrouter'
      ? 'OPENROUTER_MUSEMODEL'
      : modelProvider === 'xai'
        ? 'XAI_MODEL'
        : 'OPENAI_MODEL';
  const defaultModel =
    modelProvider === 'openrouter'
      ? field('OPENROUTER_MODEL').trim() || 'meta/muse-wonder'
      : modelProvider === 'xai'
        ? 'grok-4.7'
        : '';
  return (
    <fieldset className="desktop-provider-settings">
      <legend>
        <KeyRound size={17} /> Provider connections
      </legend>
      <p className="muted">
        <ShieldCheck size={14} /> Keys are encrypted with macOS Keychain. They
        never appear in your phone, your app download, or this form after
        saving.
      </p>
      <label className="field-label" htmlFor="model-provider">
        Chat provider
      </label>
      <select
        id="model-provider"
        value={modelProvider}
        onChange={(event) =>
          setChanges({ ...changes, MODEL_PROVIDER: event.target.value })
        }
      >
        <option value="openrouter">OpenRouter</option>
        <option value="xai">xAI</option>
        <option value="openai">OpenAI</option>
      </select>
      <label className="field-label" htmlFor="desktop-model">
        Model
      </label>
      <input
        id="desktop-model"
        value={
          changes[modelKey] ??
          (settings?.values[modelKey]?.trim() || defaultModel)
        }
        placeholder="Exact provider model ID"
        onChange={(event) =>
          setChanges({ ...changes, [modelKey]: event.target.value })
        }
      />
      {providers.map(([key, label, description]) => (
        <div key={key} className="provider-setting">
          <div className="provider-setting-heading">
            <label htmlFor={`provider-${key}`}>{label}</label>
            {settings?.configured.includes(key) && (
              <span>
                <Check size={13} /> Saved
              </span>
            )}
          </div>
          <small className="muted">{description}</small>
          <input
            id={`provider-${key}`}
            type="password"
            autoComplete="new-password"
            value={changes[key] ?? ''}
            onChange={(event) =>
              setChanges({ ...changes, [key]: event.target.value })
            }
            placeholder={
              settings?.configured.includes(key)
                ? 'Saved securely · enter a key to replace'
                : 'API key'
            }
          />
          {settings?.configured.includes(key) && (
            <button
              type="button"
              className="text-button"
              onClick={() => setChanges({ ...changes, [key]: '' })}
            >
              Remove saved key{changes[key] === '' ? ' on save' : ''}
            </button>
          )}
        </div>
      ))}
      <label className="field-label" htmlFor="voice-model">
        Voice model
      </label>
      <input
        id="voice-model"
        value={field('VOICE_MODEL')}
        onChange={(event) =>
          setChanges({ ...changes, VOICE_MODEL: event.target.value })
        }
        placeholder="Required only for calls"
      />
      {(['MEM0_BASE_URL', 'MEM0_ORG_ID', 'MEM0_PROJECT_ID'] as const).map(
        (key) => (
          <div key={key}>
            <label className="field-label" htmlFor={`desktop-${key}`}>
              {key === 'MEM0_BASE_URL'
                ? 'Mem0 API URL'
                : key === 'MEM0_ORG_ID'
                  ? 'Mem0 organization'
                  : 'Mem0 project'}
            </label>
            <input
              id={`desktop-${key}`}
              value={field(
                key,
                key === 'MEM0_BASE_URL' ? 'https://api.mem0.ai' : '',
              )}
              onChange={(event) =>
                setChanges({ ...changes, [key]: event.target.value })
              }
            />
          </div>
        ),
      )}
      <button
        type="button"
        className="primary full"
        disabled={busy || !settings || !Object.keys(changes).length}
        onClick={async () => {
          setBusy(true);
          setError('');
          try {
            await window.solanaDots!.saveSettings(changes);
          } catch (error) {
            setError(
              error instanceof Error
                ? error.message
                : 'Could not save provider settings.',
            );
            setBusy(false);
          }
        }}
      >
        {busy
          ? 'Saving and restarting workspace…'
          : 'Save provider connections'}
      </button>
      <p className="muted">
        Saving restarts the local workspace and turns Phone access off. Existing
        conversations and paired devices are retained.
      </p>
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
