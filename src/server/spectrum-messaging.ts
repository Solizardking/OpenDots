import { Spectrum, cloud, type Space, type Message } from '@spectrum-ts/core';
import { imessage } from '@spectrum-ts/imessage';
import { telegram } from '@spectrum-ts/telegram';
import { z } from 'zod';
import { safeFailure, reportChannelFailure } from './slack-channel.js';

export type SpectrumMessagingPlatform = 'telegram' | 'imessage';
export interface SpectrumMessagingConfig {
  enabled: boolean;
  projectId?: string;
  projectSecret?: string;
  telegram?: {
    botToken: string;
    expectedBotUsername?: string;
    expectedBotId?: string;
    webhookSecret: string;
    registrationApproved: boolean;
  };
  imessage?: {
    lineMode: 'shared' | 'dedicated';
    phone?: string;
    lineOwnershipConfirmed: boolean;
  };
}
export interface SpectrumProviderStatus {
  platform: SpectrumMessagingPlatform;
  configured: boolean;
  available: boolean;
  reason: string;
  botUsername?: string;
  address?: string;
}
export interface SpectrumIncomingMessage {
  platform: SpectrumMessagingPlatform;
  senderId: string;
  spaceId: string;
  messageId: string;
  text: string;
  direction: 'inbound';
  isDirect: boolean;
  /** Dedicated E.164 line, or the literal shared routing identity. Never the voice phone by default. */
  phone?: string;
}
export interface SpectrumTarget {
  platform: SpectrumMessagingPlatform;
  spaceId: string;
  phone?: string;
}
export interface SpectrumRuntime {
  providers: SpectrumProviderStatus[];
  messages: AsyncIterable<SpectrumIncomingMessage>;
  sendText(
    target: SpectrumTarget,
    text: string,
  ): Promise<{ messageId?: string }>;
  stop(): Promise<void>;
}
export type SpectrumRuntimeFactory = (
  config: SpectrumMessagingConfig,
) => Promise<SpectrumRuntime>;
type Report = (operation: string, errors: string[]) => void;
export class SpectrumMessagingError extends Error {}

export function spectrumMessagingConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpectrumMessagingConfig {
  const value = (name: string) => env[name]?.trim() || undefined;
  const botToken = value('SPECTRUM_TELEGRAM_BOT_TOKEN');
  const hasImessage = env.SPECTRUM_IMESSAGE_ENABLED === 'true';
  return {
    enabled: env.SPECTRUM_MESSAGING_ENABLED === 'true',
    projectId: value('SPECTRUM_PROJECT_ID'),
    projectSecret: value('SPECTRUM_PROJECT_SECRET'),
    ...(botToken
      ? {
          telegram: {
            botToken,
            expectedBotUsername: value('SPECTRUM_TELEGRAM_BOT_USERNAME'),
            expectedBotId: value('SPECTRUM_TELEGRAM_BOT_ID'),
            webhookSecret: value('SPECTRUM_TELEGRAM_WEBHOOK_SECRET') ?? '',
            registrationApproved:
              env.SPECTRUM_TELEGRAM_REGISTRATION_APPROVED === 'true',
          },
        }
      : {}),
    ...(hasImessage
      ? {
          imessage: {
            lineMode:
              env.SPECTRUM_IMESSAGE_LINE_MODE === 'shared'
                ? ('shared' as const)
                : ('dedicated' as const),
            phone: value('SPECTRUM_IMESSAGE_PHONE'),
            lineOwnershipConfirmed:
              env.SPECTRUM_IMESSAGE_LINE_OWNERSHIP_CONFIRMED === 'true',
          },
        }
      : {}),
  };
}
const phoneSchema = z.string().regex(/^\+[1-9]\d{6,14}$/);
const targetSchema = z
  .object({
    platform: z.enum(['telegram', 'imessage']),
    spaceId: z.string().min(1).max(320),
    phone: z.union([phoneSchema, z.literal('shared')]).optional(),
  })
  .strict();
const eventSchema = targetSchema
  .extend({
    senderId: z.string().min(1).max(320),
    messageId: z.string().min(1).max(320),
    text: z.string().min(1).max(16000),
    direction: z.literal('inbound'),
    isDirect: z.literal(true),
  })
  .strict();
const configuredStatuses = (
  config: SpectrumMessagingConfig,
): SpectrumProviderStatus[] => {
  const credentials = Boolean(config.projectId && config.projectSecret);
  return [
    {
      platform: 'telegram',
      configured:
        credentials &&
        Boolean(config.telegram?.botToken && config.telegram.webhookSecret),
      available: false,
      reason: config.enabled
        ? 'Configure a new dedicated Telegram bot and approve its webhook registration.'
        : 'Spectrum messaging is off. Add dedicated ChatGPTEE credentials and activate it on the server.',
    },
    {
      platform: 'imessage',
      configured: credentials && Boolean(config.imessage),
      available: false,
      reason: config.enabled
        ? 'Configure and verify an iMessage line owned by the ChatGPTEE Spectrum project.'
        : 'Spectrum messaging is off. Configure a ChatGPTEE cloud iMessage line separately from the voice phone.',
    },
  ];
};
function approvedConfig(
  config: SpectrumMessagingConfig,
): SpectrumMessagingConfig {
  return {
    ...config,
    telegram:
      config.telegram?.registrationApproved && config.telegram.webhookSecret
        ? config.telegram
        : undefined,
    imessage:
      config.imessage?.lineOwnershipConfirmed &&
      (config.imessage.lineMode === 'shared' ||
        phoneSchema.safeParse(config.imessage.phone).success)
        ? config.imessage
        : undefined,
  };
}
function assertStableOrigins() {
  const expected: Record<string, string> = {
    SPECTRUM_CLOUD_URL: 'https://spectrum.photon.codes',
    SPECTRUM_FUSOR_WS_URL: 'wss://fusor-ws.spectrum.photon.codes/v1/subscribe',
    SPECTRUM_SUPER_WEBHOOK: 'spctrm.dev',
    SPECTRUM_IMESSAGE_ADDRESS: 'imessage.spectrum.photon.codes:443',
  };
  for (const [key, origin] of Object.entries(expected))
    if (process.env[key] && process.env[key] !== origin)
      throw new SpectrumMessagingError(
        'Spectrum Stable requires its documented cloud, event and webhook origins. Review the server configuration before activation.',
      );
}
export function normalizeSpectrumMessage(
  space: Space,
  message: Message,
  config: SpectrumMessagingConfig,
): SpectrumIncomingMessage | undefined {
  if (
    message.direction !== 'inbound' ||
    message.sender?.kind === 'agent' ||
    !message.sender?.id ||
    message.content.type !== 'text' ||
    space.__platform !== message.platform
  )
    return;
  if (message.platform !== 'telegram' && message.platform !== 'imessage')
    return;
  let phone: string | undefined;
  let isDirect: boolean;
  if (message.platform === 'telegram') {
    if (
      !config.telegram ||
      !/^\d+$/.test(message.sender.id) ||
      space.id !== message.sender.id
    )
      return;
    isDirect = true;
  } else {
    if (!config.imessage) return;
    const narrowed = imessage(space);
    phone = narrowed.phone;
    isDirect = narrowed.type === 'dm';
    if (
      config.imessage.lineMode === 'dedicated'
        ? phone !== config.imessage.phone
        : phone !== 'shared'
    )
      return;
  }
  const result = eventSchema.safeParse({
    platform: message.platform,
    senderId: message.sender.id,
    spaceId: space.id,
    messageId: message.id,
    text: message.content.text,
    direction: 'inbound',
    isDirect,
    ...(phone ? { phone } : {}),
  });
  return result.success ? result.data : undefined;
}
interface FactoryDependencies {
  transport?: typeof fetch;
  cloudApi?: Pick<
    typeof cloud,
    'getProject' | 'getPlatforms' | 'getImessageInfo' | 'issueImessageTokens'
  >;
  initialize?: typeof Spectrum;
}
/** Read-only identity/ownership checks precede the SDK's automatic webhook registration. */
export function spectrumSdkFactory(
  dependencies: FactoryDependencies = {},
): SpectrumRuntimeFactory {
  const transport = dependencies.transport ?? fetch,
    api = dependencies.cloudApi ?? cloud,
    initialize = dependencies.initialize ?? Spectrum;
  return async (config) => {
    assertStableOrigins();
    if (!config.projectId || !config.projectSecret)
      throw new SpectrumMessagingError(
        'Dedicated ChatGPTEE Spectrum project credentials are missing.',
      );
    if (
      !config.enabled ||
      (config.telegram && !config.telegram.registrationApproved) ||
      (config.imessage && !config.imessage.lineOwnershipConfirmed)
    )
      throw new SpectrumMessagingError(
        'Provider activation requires an explicitly approved dedicated configuration.',
      );
    const authenticatedRead = async (path: string) => {
      const response = await transport(
        `https://spectrum.photon.codes/projects/${encodeURIComponent(config.projectId!)}/${path}`,
        {
          headers: {
            Authorization: `Basic ${Buffer.from(`${config.projectId}:${config.projectSecret}`).toString('base64')}`,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(10000),
        },
      );
      const body = await response.text();
      if (body.length > 65536 || !response.ok)
        throw new SpectrumMessagingError(
          'Spectrum project or line verification is unavailable.',
        );
      const parsed = z
        .object({ succeed: z.literal(true), data: z.unknown() })
        .safeParse(JSON.parse(body));
      if (!parsed.success)
        throw new SpectrumMessagingError(
          'Spectrum did not verify this project.',
        );
      return parsed.data.data;
    };
    const project = z
      .object({
        id: z.string().optional(),
        slug: z.string(),
        name: z.string(),
        profile: z.record(z.string(), z.unknown()),
      })
      .parse(
        dependencies.cloudApi
          ? await api.getProject(config.projectId, config.projectSecret)
          : await authenticatedRead(''),
      );
    if (
      (project.id && project.id !== config.projectId) ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(project.slug)
    )
      throw new SpectrumMessagingError(
        'The Spectrum project identity could not be verified.',
      );
    const statuses: SpectrumProviderStatus[] = [];
    if (config.telegram) {
      const token = config.telegram.botToken;
      if (
        !/^\d{5,20}:[A-Za-z0-9_-]{20,200}$/.test(token) ||
        !/^[A-Za-z0-9_-]{16,256}$/.test(config.telegram.webhookSecret)
      )
        throw new SpectrumMessagingError(
          'Set a valid dedicated Telegram bot token and webhook verification secret.',
        );
      const read = async (method: 'getMe' | 'getWebhookInfo') => {
        const response = await transport(
          `https://api.telegram.org/bot${token}/${method}`,
          {
            method: 'GET',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
          },
        );
        const body = await response.text();
        if (body.length > 65536 || !response.ok)
          throw new SpectrumMessagingError(
            'Telegram identity or webhook verification is unavailable.',
          );
        const parsed = z
          .object({ ok: z.literal(true), result: z.unknown() })
          .safeParse(JSON.parse(body));
        if (!parsed.success)
          throw new SpectrumMessagingError('Telegram did not verify this bot.');
        return parsed.data.result;
      };
      const identity = z
        .object({
          id: z.number().int().positive().refine(Number.isSafeInteger),
          is_bot: z.literal(true),
          username: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{4,31}$/),
        })
        .parse(await read('getMe'));
      if (
        (config.telegram.expectedBotId &&
          config.telegram.expectedBotId !== String(identity.id)) ||
        (config.telegram.expectedBotUsername &&
          config.telegram.expectedBotUsername
            .replace(/^@/, '')
            .toLowerCase() !== identity.username.toLowerCase())
      )
        throw new SpectrumMessagingError(
          'The Telegram token belongs to a different bot than configured.',
        );
      const webhook = z
        .object({ url: z.string().max(2048) })
        .parse(await read('getWebhookInfo'));
      if (
        webhook.url &&
        webhook.url !== `https://${project.slug}.spctrm.dev/telegram`
      )
        throw new SpectrumMessagingError(
          'This bot already has another active webhook. Create a separate ChatGPTEE bot before activating Spectrum.',
        );
      statuses.push({
        platform: 'telegram',
        configured: true,
        available: true,
        reason:
          'Dedicated Telegram bot identity verified; Spectrum receives its direct messages.',
        botUsername: identity.username,
      });
    }
    if (config.imessage) {
      const platforms = z
        .object({ imessage: z.object({ enabled: z.boolean() }) })
        .parse(
          dependencies.cloudApi
            ? await api.getPlatforms(config.projectId)
            : await authenticatedRead('platforms/'),
        );
      if (!platforms.imessage?.enabled)
        throw new SpectrumMessagingError(
          'Enable iMessage on the dedicated ChatGPTEE Spectrum project.',
        );
      const info = z
        .object({ type: z.enum(['shared', 'dedicated']) })
        .parse(
          dependencies.cloudApi
            ? await api.getImessageInfo(config.projectId)
            : await authenticatedRead('imessage/'),
        );
      if (info.type !== config.imessage.lineMode)
        throw new SpectrumMessagingError(
          'The configured iMessage line mode differs from the project allocation.',
        );
      if (info.type === 'dedicated') {
        const tokens = await api.issueImessageTokens(
          config.projectId,
          config.projectSecret,
        );
        if (
          tokens.type !== 'dedicated' ||
          !Object.values(tokens.numbers).includes(config.imessage.phone!)
        )
          throw new SpectrumMessagingError(
            'The selected iMessage phone is not a dedicated line owned by this project.',
          );
      }
      statuses.push({
        platform: 'imessage',
        configured: true,
        available: true,
        reason:
          info.type === 'dedicated'
            ? 'Dedicated cloud iMessage line verified and pinned.'
            : 'Cloud iMessage shared routing is configured; its sender number can vary by recipient.',
        ...(info.type === 'dedicated'
          ? { address: config.imessage.phone }
          : {}),
      });
    }
    const providers = [
      ...(config.imessage ? [imessage.config()] : []),
      ...(config.telegram
        ? [
            telegram.config({
              botToken: config.telegram.botToken,
              webhookSecret: config.telegram.webhookSecret,
              baseUrl: 'https://api.telegram.org',
            }),
          ]
        : []),
    ];
    const app = await initialize({
      projectId: config.projectId,
      projectSecret: config.projectSecret,
      providers,
      telemetry: false,
      options: { logLevel: 'error' },
    });
    return {
      providers: statuses,
      messages: (async function* () {
        for await (const [space, message] of app.messages) {
          const event = normalizeSpectrumMessage(space, message, config);
          if (event) yield event;
        }
      })(),
      sendText: async (target, text) => {
        const space =
          target.platform === 'telegram'
            ? await telegram(app).space.get(target.spaceId)
            : await imessage(app).space.get(target.spaceId, {
                phone: target.phone,
              });
        const message = await space.send(text);
        return message ? { messageId: message.id } : {};
      },
      stop: () => app.stop(),
    };
  };
}
/** One global provider connection. Root routing owns persistent account bindings and agent queues. */
export class SpectrumMessagingTransport {
  private runtime?: SpectrumRuntime;
  private starting?: Promise<SpectrumProviderStatus[]>;
  private consuming?: Promise<void>;
  private stopped = true;
  private generation = 0;
  private providers: SpectrumProviderStatus[];
  private seen = new Set<string>();
  constructor(
    private config: SpectrumMessagingConfig,
    private onMessage: (message: SpectrumIncomingMessage) => Promise<void>,
    private report: Report = reportChannelFailure,
    private factory: SpectrumRuntimeFactory = spectrumSdkFactory(),
  ) {
    this.providers = configuredStatuses(config);
  }
  status() {
    return this.providers.map((provider) => ({ ...provider }));
  }
  start(): Promise<SpectrumProviderStatus[]> {
    if (this.runtime) return Promise.resolve(this.status());
    if (this.starting) return this.starting;
    if (!this.config.enabled) return Promise.resolve(this.status());
    const approved = approvedConfig(this.config);
    if (
      !approved.projectId ||
      !approved.projectSecret ||
      (!approved.telegram && !approved.imessage)
    )
      return Promise.resolve(this.status());
    this.stopped = false;
    const generation = ++this.generation;
    this.starting = (async () => {
      try {
        const runtime = await this.factory(approved);
        if (this.stopped || generation !== this.generation) {
          await runtime.stop();
          return this.status();
        }
        this.runtime = runtime;
        this.providers = this.providers.map(
          (provider) =>
            runtime.providers.find(
              (active) => active.platform === provider.platform,
            ) ?? provider,
        );
        this.consuming = this.consume(runtime, approved, generation);
        return this.status();
      } catch (error) {
        this.providers = this.providers.map((provider) => ({
          ...provider,
          available: false,
          reason:
            error instanceof SpectrumMessagingError
              ? error.message
              : 'Spectrum provider activation failed. Check dedicated credentials and provider setup.',
        }));
        this.report('Spectrum activation failed', [safeFailure(error)]);
        return this.status();
      } finally {
        this.starting = undefined;
      }
    })();
    return this.starting;
  }
  private async consume(
    runtime: SpectrumRuntime,
    config: SpectrumMessagingConfig,
    generation: number,
  ) {
    try {
      for await (const raw of runtime.messages) {
        if (this.stopped || generation !== this.generation) break;
        const parsed = eventSchema.safeParse(raw);
        if (!parsed.success) continue;
        const message = parsed.data;
        if (
          message.platform === 'telegram'
            ? !config.telegram || message.spaceId !== message.senderId
            : !config.imessage ||
              (config.imessage.lineMode === 'dedicated'
                ? message.phone !== config.imessage.phone
                : message.phone !== 'shared')
        )
          continue;
        const key = JSON.stringify([
          message.platform,
          message.phone ?? '',
          message.spaceId,
          message.messageId,
        ]);
        if (this.seen.has(key)) continue;
        this.seen.add(key);
        if (this.seen.size > 10000)
          this.seen.delete(this.seen.values().next().value!);
        try {
          await this.onMessage(message);
        } catch (error) {
          this.report('Spectrum account message handling failed', [
            safeFailure(error),
          ]);
        }
      }
    } catch (error) {
      if (!this.stopped)
        this.report('Spectrum message stream failed', [safeFailure(error)]);
    }
    if (!this.stopped && generation === this.generation)
      this.providers = this.providers.map((provider) => ({
        ...provider,
        available: false,
        reason:
          'Spectrum message stream disconnected. Restart the server after checking provider status.',
      }));
  }
  async sendText(target: SpectrumTarget, text: string) {
    const parsed = targetSchema.safeParse(target);
    if (!parsed.success || !text.trim() || text.length > 4000)
      throw new SpectrumMessagingError(
        'Send a nonempty message of at most 4,000 characters to an explicitly linked conversation.',
      );
    const value = parsed.data;
    if (
      value.platform === 'telegram'
        ? !/^\d{1,20}$/.test(value.spaceId) || value.phone !== undefined
        : !this.config.imessage ||
          (this.config.imessage.lineMode === 'dedicated'
            ? value.phone !== this.config.imessage.phone
            : value.phone !== 'shared')
    )
      throw new SpectrumMessagingError(
        'Use the exact linked direct conversation and its verified iMessage routing line.',
      );
    if (
      this.stopped ||
      !this.runtime ||
      !this.providers.some(
        (provider) =>
          provider.platform === value.platform && provider.available,
      )
    )
      throw new SpectrumMessagingError(
        'This messaging provider is unavailable.',
      );
    try {
      return await this.runtime.sendText(value, text);
    } catch (error) {
      this.report('Spectrum reply failed', [safeFailure(error)]);
      throw new SpectrumMessagingError(
        'The reply could not be verified. It will not be resent automatically.',
      );
    }
  }
  async stop() {
    if (this.stopped && !this.starting && !this.runtime) return;
    this.stopped = true;
    this.generation++;
    await this.starting;
    const runtime = this.runtime;
    this.runtime = undefined;
    try {
      await runtime?.stop();
    } catch (error) {
      this.report('Spectrum shutdown failed', [safeFailure(error)]);
    }
    await this.consuming;
    this.consuming = undefined;
    this.seen.clear();
    this.providers = this.providers.map((provider) => ({
      ...provider,
      available: false,
      reason: 'Spectrum messaging is stopped.',
    }));
  }
}
